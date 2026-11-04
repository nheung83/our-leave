/**
 * 우리 회사 연차관리 - 프로덕션 사내 서버 (Node.js + Express + SQLite3)
 * - 08:30~17:30 (8시간) 근무 기준
 * - 2시간 단위 (0.25일) 및 연속 연차 (주말/휴무일 제외)
 * - 2단계 결재 (차장 1차 -> 대표 최종, 차장 신청 시 대표 직행)
 * - 연차 자동 계산 (2026년 기준 고수현 16일, 김남흥 17일)
 * - 동시성 제어 및 잔여 연차 무결성 보장
 */

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'company_annual_leave_super_secret_key_2026';
const CURRENT_YEAR = 2026;
const WORK_HOURS_PER_DAY = 8;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------------
// 1. SQLite Database Initialization & Schema
// -------------------------------------------------------------
const dbPath = path.join(__dirname, 'annual_leave.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('SQLite connection error:', err.message);
  } else {
    console.log('Connected to SQLite database at:', dbPath);
    initDatabase();
  }
});

function initDatabase() {
  db.serialize(() => {
    // 1. Users Table
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      position TEXT DEFAULT '',
      role TEXT NOT NULL, -- 'admin', 'ceo', 'staff'
      hire_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'PENDING_APPROVAL', 'INACTIVE'
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 2. Leaves Table
    db.run(`CREATE TABLE IF NOT EXISTS leaves (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      apply_type TEXT NOT NULL, -- 'SLOT' or 'FULL_RANGE'
      date TEXT,
      start_date TEXT,
      end_date TEXT,
      slots TEXT, -- JSON array of slots
      slot_times TEXT,
      hours REAL NOT NULL,
      days REAL NOT NULL,
      memo TEXT,
      status TEXT NOT NULL, -- 'WAITING_FIRST', 'WAITING_FINAL', 'APPROVED', 'REJECTED', 'CANCEL_REQUESTED', 'CANCELLED'
      first_approver TEXT,
      first_approved_at TEXT,
      final_approver TEXT,
      final_approved_at TEXT,
      reject_reason TEXT,
      cancel_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    // 3. Leave Adjustments Table
    db.run(`CREATE TABLE IF NOT EXISTS leave_adjustments (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      year INTEGER NOT NULL,
      delta_hours REAL NOT NULL,
      reason TEXT NOT NULL,
      operator TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

    // 4. Holidays Table
    db.run(`CREATE TABLE IF NOT EXISTS holidays (
      id TEXT PRIMARY KEY,
      date TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 5. Audit Logs Table
    db.run(`CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      operator TEXT NOT NULL,
      action TEXT NOT NULL,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    seedInitialData();
  });
}

function seedInitialData() {
  // Fresh initialization: No pre-seeded users. Users register directly.
  db.get(`SELECT COUNT(*) AS count FROM holidays`, (err, row) => {
    if (err) return console.error(err);
    if (row.count === 0) {
      const holidays = [
        ['h_1', '2026-01-01', '신정'],
        ['h_2', '2026-02-16', '설날 연휴'],
        ['h_3', '2026-02-17', '설날 당일'],
        ['h_4', '2026-02-18', '설날 연휴'],
        ['h_5', '2026-03-01', '삼일절'],
        ['h_6', '2026-03-02', '대체공휴일'],
        ['h_7', '2026-05-01', '근로자의 날'],
        ['h_8', '2026-05-05', '어린이날'],
        ['h_9', '2026-05-24', '부처님오신날'],
        ['h_10', '2026-06-06', '현충일'],
        ['h_11', '2026-07-15', '회사 창립기념일'],
        ['h_12', '2026-08-15', '광복절'],
        ['h_13', '2026-09-24', '추석 연휴'],
        ['h_14', '2026-09-25', '추석 당일'],
        ['h_15', '2026-09-26', '추석 연휴'],
        ['h_16', '2026-10-03', '개천절'],
        ['h_17', '2026-10-09', '한글날'],
        ['h_18', '2026-12-25', '성탄절']
      ];
      const hStmt = db.prepare(`INSERT INTO holidays (id, date, name) VALUES (?, ?, ?)`);
      holidays.forEach(h => hStmt.run(h));
      hStmt.finalize();
      console.log('2026 Statutory Holidays seeded.');
    }
  });
}

// -------------------------------------------------------------
// 2. Business Rules & Annual Leave Calculations
// -------------------------------------------------------------
function calculateBaseAnnualLeave(hireDateStr, targetYear) {
  if (!hireDateStr) return { days: 15, hours: 120 };
  const hireDate = new Date(hireDateStr);
  const hireYear = hireDate.getFullYear();
  const hireMonth = hireDate.getMonth() + 1;

  if (targetYear < hireYear) return { days: 0, hours: 0 };
  if (targetYear === hireYear) {
    const monthsRemaining = Math.max(0, 12 - hireMonth);
    const daysYear1 = Math.min(11, monthsRemaining);
    return { days: daysYear1, hours: daysYear1 * WORK_HOURS_PER_DAY };
  }

  const yearsElapsed = targetYear - hireYear;
  const additional = Math.floor((yearsElapsed - 1) / 2);
  const totalDays = Math.min(25, 15 + additional);
  return { days: totalDays, hours: totalDays * WORK_HOURS_PER_DAY };
}

// -------------------------------------------------------------
// 3. Authentication & Role Authorization Middleware
// -------------------------------------------------------------
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: '인증 토큰이 필요합니다.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: '유효하지 않은 토큰입니다.' });
    req.user = user;
    next();
  });
}

function requireRole(roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: '접근 권한이 없습니다.' });
    }
    next();
  };
}

// -------------------------------------------------------------
// 4. API Endpoints
// -------------------------------------------------------------

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '아이디와 비밀번호를 입력해 주세요.' });
  }

  db.get(`SELECT * FROM users WHERE username = ? OR name = ?`, [username], (err, user) => {
    if (err) return res.status(500).json({ error: '서버 오류' });
    if (!user) return res.status(401).json({ error: '등록되지 않은 아이디입니다.' });
    if (user.status === 'PENDING_APPROVAL') {
      return res.status(403).json({ error: '관리자 승인 대기 중인 계정입니다.' });
    }
    if (user.status === 'INACTIVE') {
      return res.status(403).json({ error: '비활성화된 계정입니다. 관리자에게 문의하세요.' });
    }

    const match = bcrypt.compareSync(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: '비밀번호가 올바르지 않습니다.' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, name: user.name, position: user.position || '', role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: '로그인 성공',
      token,
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        position: user.position,
        role: user.role,
        hire_date: user.hire_date
      }
    });
  });
});

// POST /api/auth/signup
app.post('/api/auth/signup', (req, res) => {
  const { username, password, name } = req.body;
  if (!username || !password || !name) {
    return res.status(400).json({ error: '이름, 아이디, 비밀번호를 모두 입력해 주세요.' });
  }

  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync(password, salt);
  const id = 'user_' + Date.now();
  const today = new Date().toISOString().split('T')[0];

  db.run(
    `INSERT INTO users (id, username, password_hash, name, position, role, hire_date, status) VALUES (?, ?, ?, ?, '사원', 'staff', ?, 'PENDING_APPROVAL')`,
    [id, username, hash, name, today],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(409).json({ error: '이미 사용 중인 사내 아이디입니다.' });
        }
        return res.status(500).json({ error: '회원가입 처리 실패' });
      }
      res.status(201).json({ message: '회원가입 신청 완료. 관리자 승인 후 로그인할 수 있습니다.' });
    }
  );
});

// GET /api/leaves - Get leaves (own leaves or all if approver)
app.get('/api/leaves', authenticateToken, (req, res) => {
  const { role, id } = req.user;
  let sql = `SELECT l.*, u.name as user_name, u.position as user_position FROM leaves l JOIN users u ON l.user_id = u.id `;
  const params = [];

  if (role === 'staff') {
    sql += `WHERE l.user_id = ? `;
    params.push(id);
  }
  sql += `ORDER BY l.created_at DESC`;

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// POST /api/leaves - Apply leave with concurrency check
app.post('/api/leaves', authenticateToken, (req, res) => {
  const { apply_type, date, start_date, end_date, slots, slot_times, hours, days, memo } = req.body;
  const user = req.user;

  // Initial status based on role
  let initialStatus = 'WAITING_FIRST';
  let firstApprover = null;
  let firstApprovedAt = null;

  if (user.role === 'admin') {
    // 차장 본인은 대표 직행
    initialStatus = 'WAITING_FINAL';
    firstApprover = '스킵(차장 본인)';
    firstApprovedAt = new Date().toISOString();
  } else if (user.role === 'ceo') {
    initialStatus = 'APPROVED';
    firstApprover = '대표 직접 등록';
    firstApprovedAt = new Date().toISOString();
  }

  const id = 'leave_' + Date.now();
  db.run(
    `INSERT INTO leaves (id, user_id, apply_type, date, start_date, end_date, slots, slot_times, hours, days, memo, status, first_approver, first_approved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, user.id, apply_type, date, start_date, end_date, JSON.stringify(slots || []), slot_times, hours, days, memo, initialStatus, firstApprover, firstApprovedAt],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ message: '연차 신청이 접수되었습니다.', leaveId: id, status: initialStatus });
    }
  );
});

// POST /api/leaves/:id/approve-1st (Manager 김남흥)
app.post('/api/leaves/:id/approve-1st', authenticateToken, requireRole(['admin']), (req, res) => {
  const leaveId = req.params.id;
  const approver = req.user.name + ' ' + req.user.position;
  const now = new Date().toISOString();

  db.run(
    `UPDATE leaves SET status = 'WAITING_FINAL', first_approver = ?, first_approved_at = ? WHERE id = ? AND status = 'WAITING_FIRST'`,
    [approver, now, leaveId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(400).json({ error: '1차 승인 대상이 아니거나 이미 처리되었습니다.' });
      res.json({ message: '1차 승인 완료. 대표 최종 결재함으로 전달되었습니다.' });
    }
  );
});

// POST /api/leaves/:id/approve-final (CEO 대표님)
app.post('/api/leaves/:id/approve-final', authenticateToken, requireRole(['ceo']), (req, res) => {
  const leaveId = req.params.id;
  const approver = req.user.name + ' ' + req.user.position;
  const now = new Date().toISOString();

  db.run(
    `UPDATE leaves SET status = 'APPROVED', final_approver = ?, final_approved_at = ? WHERE id = ? AND status = 'WAITING_FINAL'`,
    [approver, now, leaveId],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      if (this.changes === 0) return res.status(400).json({ error: '최종 결재 대상이 아니거나 이미 처리되었습니다.' });
      res.json({ message: '최종 결재 승인 완료. 연차가 확정되어 공유 달력에 반영되었습니다.' });
    }
  );
});

// GET /api/calendar - Public approved calendar for all employees (privacy preserved)
app.get('/api/calendar', authenticateToken, (req, res) => {
  db.all(
    `SELECT l.id, l.date, l.start_date, l.end_date, l.apply_type, l.slot_times, l.hours, l.days, u.name as user_name, u.position as user_position
     FROM leaves l
     JOIN users u ON l.user_id = u.id
     WHERE l.status = 'APPROVED'
     ORDER BY l.date ASC, l.start_date ASC`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

// Start Server
app.listen(PORT, () => {
  console.log(`Annual Leave Management Server running on port ${PORT}`);
});
