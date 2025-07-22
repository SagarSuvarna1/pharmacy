const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = 3000;

// Setup EJS template engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use('/public', express.static(path.join(__dirname, 'public')));

// Body parser
app.use(bodyParser.urlencoded({ extended: true }));  // <--- Change false to true

app.use(bodyParser.json());

// Sessions
// Trust Proxy: Required for secure cookies to work on Render!
app.set('trust proxy', 1);

app.use(session({
  secret: 'pharmacy-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    sameSite: 'lax',
    secure: true  // Set to true because Render uses HTTPS for your live URL
  }
}));


// SQLite database connection
const db = new sqlite3.Database('./pharmacy.db', (err) => {
  if (err) console.error('DB connection error:', err);
  else console.log('Connected to SQLite DB');
});

// Initialize DB tables if not exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE, password_hash TEXT, name TEXT, role TEXT DEFAULT 'user'
    )`);
  db.run(`
    CREATE TABLE IF NOT EXISTS pharmacy (
      id INTEGER PRIMARY KEY,
      name TEXT,
      address TEXT
    )`);
  db.run(`
    CREATE TABLE IF NOT EXISTS drugs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE, name TEXT, generic_name TEXT,
      manufacturer TEXT, classification TEXT, required INTEGER DEFAULT 0
    )`);
  db.run(`
    CREATE TABLE IF NOT EXISTS drug_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drug_id INTEGER,
      batch_number TEXT, expiry DATE, mrp REAL, sale_price REAL,
      purchase_date DATE, opening_stock INTEGER DEFAULT 0, current_stock INTEGER DEFAULT 0
    )`);
  db.run(`
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_name TEXT, patient_address TEXT, patient_mobile TEXT,
      doctor_name TEXT, sale_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      user_id INTEGER, total_amount REAL,
      payment_mode TEXT, payment_reference TEXT, amount_received REAL, change_returned REAL
    )`);
  db.run(`
    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER, drug_id INTEGER, batch_id INTEGER, qty INTEGER, price REAL
    )`);

  // Insert one user and pharmacy if not exists
  db.get("SELECT * FROM users WHERE username = 'admin'", async (err, row) => {
    if (!row) {
      const hash = await bcrypt.hash('admin123', 10);
      db.run("INSERT INTO users (username, password_hash, name, role) VALUES (?, ?, ?, 'admin')",
        ['admin', hash, 'Administrator']);
    }
  });
  db.get("SELECT * FROM pharmacy", (err, row) => {
    if (!row) db.run("INSERT INTO pharmacy (id, name, address) VALUES (1, 'My Pharmacy', '123 Main Road')");
  });
});

// --- Helper: Auth ---
function ensureAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  next();
}

// --- Login routes ---
// Homepage route - handles 404 on base URL
app.get('/', (req, res) => {
  // If user is logged in, redirect to dashboard, else to login page
  if (req.session.user) {
    res.redirect('/dashboard');
  } else {
    res.redirect('/login');
  }
});

// ---- Login routes ----

// Show login page
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

// Handle login form submission
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  db.get("SELECT * FROM users WHERE username = ?", [username], async (err, user) => {
    if (err || !user) {
      // Invalid user
      return res.render('login', { error: 'Invalid user!' });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      // Incorrect password
      return res.render('login', { error: 'Invalid password!' });
    }
    // Successful login
    req.session.user = {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role
    };
    res.redirect('/dashboard');
  });
});

// Logout route
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});


// --- Dashboard ---
// --- Dashboard ---
// Replace this route in your app.js with the one below:
app.get('/dashboard', ensureAuth, (req, res) => {
  db.get("SELECT * FROM pharmacy", (err, pharmacy) => {
    // Today as YYYY-MM-DD
    const today = new Date().toISOString().slice(0, 10);
    // Get stats
    db.serialize(() => {
      let stats = {};
      db.get(`SELECT COUNT(*) as cnt, IFNULL(SUM(total_amount),0) as amt FROM sales WHERE date(sale_date) = ?`, [today], (err, row1) => {
        stats.todaySalesCount = row1.cnt;
        stats.todaySalesAmt = row1.amt;
        db.get(`SELECT IFNULL(SUM(total_amount - IFNULL(amount_received,0)),0) as pending FROM sales WHERE payment_mode='Credit' AND (total_amount > IFNULL(amount_received,0))`, (err, row2) => {
          stats.pending = row2.pending;
          db.get(`SELECT COUNT(*) as drugs FROM drugs`, (err, r3) => {
            stats.drugCount = r3.drugs;
            db.get(`SELECT COUNT(*) as stockBatches FROM drug_batches`, (err, r4) => {
              stats.stockBatches = r4.stockBatches;
              db.get(`SELECT IFNULL(SUM(current_stock),0) as totalStock FROM drug_batches`, (err, r5) => {
                stats.totalStock = r5.totalStock;
                return res.render('dashboard', {
                  user: req.session.user,
                  pharmacy,
                  stats
                });
              });
            });
          });
        });
      });
    });
  });
});


// --- Drug Master ---
app.get('/drugs', ensureAuth, (req, res) => {
  db.all("SELECT * FROM drugs ORDER BY name", (err, list) => res.render('drugs', { list: list || [] }));
});
app.get('/drugs/add', ensureAuth, (req, res) => res.render('drugs_add', { message: null }));
app.post('/drugs/add', ensureAuth, (req, res) => {
  const { code, name, generic_name, manufacturer, classification, required } = req.body;
  db.run(
    "INSERT INTO drugs (code, name, generic_name, manufacturer, classification, required) VALUES (?, ?, ?, ?, ?, ?)",
    [code, name, generic_name, manufacturer, classification, required ? 1 : 0],
    function (err) {
      if (err) {
        res.render('drugs_add', { message: { success: false, text: 'Error: Drug code must be unique.' } });
      } else {
        res.render('drugs_add', { message: { success: true, text: 'Drug added!' } });
      }
    }
  );
});

// --- Opening Stock / Batch Entry ---
app.get('/stock', ensureAuth, (req, res) => {
  db.all(`
    SELECT b.*, d.name as drug_name 
    FROM drug_batches b LEFT JOIN drugs d ON d.id = b.drug_id 
    ORDER BY d.name
    `, (err, stocks) => res.render('stock', { stocks: stocks || [] })
  );
});
app.get('/stock/add', ensureAuth, (req, res) => {
  db.all("SELECT * FROM drugs ORDER BY name", (err, drugs) =>
    res.render('stock_add', { drugs: drugs || [], message: null })
  );
});
app.post('/stock/add', ensureAuth, (req, res) => {
  const { drug_id, batch_number, expiry, mrp, sale_price, purchase_date, opening_stock } = req.body;
  db.run(`INSERT INTO drug_batches
    (drug_id, batch_number, expiry, mrp, sale_price, purchase_date, opening_stock, current_stock)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      drug_id,
      batch_number,
      expiry ? (expiry.length === 7 ? expiry + "-01" : expiry) : null,
      mrp,
      sale_price,
      purchase_date,
      opening_stock,
      opening_stock
    ],
    function (err) {
      let msg;
      if (err) msg = { success: false, text: 'Batch insertion error (check unique batch/drug).' };
      else msg = { success: true, text: 'Batch added.' };
      db.all("SELECT * FROM drugs ORDER BY name", (err, drugs) =>
        res.render('stock_add', { drugs: drugs || [], message: msg })
      );
    }
  );
});

// --- Inventory ---
app.get('/inventory', ensureAuth, (req, res) => {
  db.all(`
    SELECT b.*, d.code as drug_code, d.name as drug_name
    FROM drug_batches b
    LEFT JOIN drugs d ON d.id = b.drug_id
    ORDER BY d.name, b.expiry
  `, (err, batches) => {
    res.render('inventory', { batches: batches || [] });
  });
});

// --- Billing GET/POST ---
app.get('/billing', ensureAuth, (req, res) => {
  db.all("SELECT id, code, name FROM drugs ORDER BY name", (err, drugs) => {
    db.all("SELECT * FROM drug_batches", (err2, batches) => {
      let batchesByDrug = {};
      (batches || []).forEach(b => {
        batchesByDrug[b.drug_id] = batchesByDrug[b.drug_id] || [];
        batchesByDrug[b.drug_id].push(b);
      });
      res.render('billing', { drugs: drugs || [], batchesByDrug, message: null });
    });
  });
});

app.post('/billing', ensureAuth, (req, res) => {
  console.log('DEBUG REQ.BODY:', JSON.stringify(req.body, null, 2));
  let { patient_name, patient_address, patient_mobile, doctor_name, drugs, payment_mode, payment_reference, amount_received } = req.body;

  // Defensive fix for drugs: handle case when drugs is undefined/null/empty
  let saleItems = [];
  if (drugs) {
    if (Array.isArray(drugs)) saleItems = drugs.filter(x => x && typeof x === 'object');
    else if (typeof drugs === 'object') saleItems = Object.values(drugs);
    saleItems = saleItems.filter(dg => dg && dg.drug_id && dg.batch_id && dg.qty);
  }

  if (!saleItems.length) {
    return db.all("SELECT id, code, name FROM drugs ORDER BY name", (err, drugslist) =>
      db.all("SELECT * FROM drug_batches", (err2, batches) => {
        let batchesByDrug = {};
        (batches || []).forEach(b => {
          batchesByDrug[b.drug_id] = batchesByDrug[b.drug_id] || [];
          batchesByDrug[b.drug_id].push(b);
        });
        res.render('billing', { drugs: drugslist || [], batchesByDrug, message: { success: false, text: "No items selected!" } });
      })
    );
  }

  // Calculate total, change
  const saleTotal = saleItems.reduce((s, dg) => s + (+dg.sale_price || 0) * (+dg.qty || 0), 0);
  let change_returned = 0;
  if (payment_mode === "Cash" && amount_received) {
    change_returned = (+amount_received || 0) - saleTotal;
    if (change_returned < 0) change_returned = 0;
  }
  db.run(
    `INSERT INTO sales
      (patient_name, patient_address, patient_mobile, doctor_name, user_id, total_amount, payment_mode, payment_reference, amount_received, change_returned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      patient_name,
      patient_address,
      patient_mobile,
      doctor_name,
      req.session.user.id,
      saleTotal,
      payment_mode,
      payment_reference,
      amount_received,
      change_returned
    ],
    function (err) {
      if (err) {
        return db.all("SELECT id, code, name FROM drugs ORDER BY name", (err, drugslist) =>
          db.all("SELECT * FROM drug_batches", (err2, batches) => {
            let batchesByDrug = {};
            (batches || []).forEach(b => {
              batchesByDrug[b.drug_id] = batchesByDrug[b.drug_id] || [];
              batchesByDrug[b.drug_id].push(b);
            });
            res.render('billing', { drugs: drugslist || [], batchesByDrug, message: { success: false, text: "Bill error. Try again." } });
          })
        );
      }
      const sale_id = this.lastID;
      let completed = 0, fail = false;
      saleItems.forEach(function (item) {
        db.run(
          `INSERT INTO sale_items (sale_id, drug_id, batch_id, qty, price) VALUES (?, ?, ?, ?, ?)`,
          [sale_id, item.drug_id, item.batch_id, item.qty, item.sale_price],
          function (err2) {
            if (!fail && err2) { fail = true; }
            db.run(
              `UPDATE drug_batches SET current_stock = current_stock - ? WHERE id = ?`,
              [item.qty, item.batch_id],
              function (errU) { completed++; if (completed === saleItems.length) afterFinish(); }
            );
          }
        );
      });
      if (!saleItems.length) afterFinish();
    function afterFinish() {
  if (fail) {
    // Fetch latest drugs & batches and show billing page with error
    db.all("SELECT id, code, name FROM drugs ORDER BY name", (err, drugslist) => {
      db.all("SELECT * FROM drug_batches", (err2, batches) => {
        let batchesByDrug = {};
        (batches || []).forEach(b => {
          batchesByDrug[b.drug_id] = batchesByDrug[b.drug_id] || [];
          batchesByDrug[b.drug_id].push(b);
        });
        res.render('billing', {
          drugs: drugslist || [],
          batchesByDrug,
          message: { success: false, text: "Error saving some items." }
        });
      });
    });
  } else {
    // Redirect to printable receipt page (new GET route)
    res.redirect('/billing/receipt/' + sale_id);
  }
}
          });
        });
      
    
  


// --- Sales Report ---
app.get('/reports/sales', ensureAuth, (req, res) => {
  const from = req.query.from || '';
  const to = req.query.to || '';
  let query = `
    SELECT s.*, u.name as user_name
    FROM sales s 
    LEFT JOIN users u ON u.id = s.user_id
    WHERE 1=1`;
  let params = [];
  if (from) { query += ' AND s.sale_date >= ?'; params.push(from + ' 00:00:00'); }
  if (to) { query += ' AND s.sale_date <= ?'; params.push(to + ' 23:59:59'); }
  query += ' ORDER BY s.sale_date DESC;';
  db.all(query, params, (err, sales) => {
    if (!sales || sales.length === 0) {
      return res.render('sales_report', { sales: [], from, to });
    }
    let done = 0;
    sales.forEach((sale, idx) => {
      db.all(`
        SELECT si.*, d.name as drug_name, db.batch_number, db.expiry
        FROM sale_items si
        LEFT JOIN drugs d ON d.id = si.drug_id
        LEFT JOIN drug_batches db ON db.id = si.batch_id
        WHERE si.sale_id = ?;`,
        [sale.id],
        (err2, items) => {
          sales[idx].items = items || [];
          done++;
          if (done === sales.length) {
            res.render('sales_report', { sales, from, to });
          }
        });
    });
  });
});

// --- User Collection Report ---
app.get('/reports/collection', ensureAuth, (req, res) => {
  const from = req.query.from || '';
  const to = req.query.to || '';
  let query = `
    SELECT date(s.sale_date) as date, u.name as user_name,
           COUNT(s.id) as bill_count, SUM(s.total_amount) as total_amount
    FROM sales s LEFT JOIN users u ON u.id = s.user_id
    WHERE 1=1`;
  let params = [];
  if (from) { query += ' AND date(s.sale_date) >= ?'; params.push(from); }
  if (to) { query += ' AND date(s.sale_date) <= ?'; params.push(to); }
  query += ` GROUP BY date, u.name ORDER BY date DESC, u.name`;

  db.all(query, params, (err, collections) => {
    res.render('user_collection', { collections: collections || [], from, to });
  });
});

// 404 fallback




// GET /billing/receipt/:id - Show receipt for print
app.get('/billing/receipt/:id', ensureAuth, (req, res) => {
  const saleId = req.params.id;
  db.get(
    `SELECT s.*, u.name as user_name 
     FROM sales s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    [saleId],
    (err, sale) => {
      if (!sale) return res.send('Bill not found');
      db.all(
        `SELECT si.*, d.name as drug_name, db.batch_number, db.expiry
         FROM sale_items si
         LEFT JOIN drugs d ON d.id = si.drug_id
         LEFT JOIN drug_batches db ON db.id = si.batch_id
         WHERE si.sale_id = ?`,
        [saleId],
        (err2, items) => {
          db.get("SELECT * FROM pharmacy", (err3, pharmacy) => {
            res.render('receipt', { sale, items, pharmacy });
          });
        }
      );
    }
  );
});

app.use((req, res) => res.status(404).send('<h2>404 Not found</h2>'));


// Start server
app.listen(PORT, () => {
  console.log(`Pharmacy app listening: http://localhost:${PORT}/login`);
});
