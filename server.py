#!/usr/bin/env python3
"""
CMK Club Rugby Tipping — Taranaki
Full-stack tipping web app: Python stdlib server + SQLite
"""

import json, os, sqlite3, hashlib, hmac, secrets, time, re
from http.server import HTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
from datetime import datetime, timezone

DB_PATH = os.path.join(os.path.dirname(__file__), "cmk_tipping.db")
SECRET = secrets.token_hex(32)
PORT = int(os.environ.get("PORT", 3000))

# ── Helpers ──────────────────────────────────────────────────────────────

def hash_password(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt.encode(), 100_000)
    return salt + ":" + h.hex()

def check_password(pw, stored):
    salt, _ = stored.split(":", 1)
    return hash_password(pw, salt) == stored

def make_token(user_id, is_admin):
    payload = f"{user_id}:{is_admin}:{time.time()}"
    sig = hmac.new(SECRET.encode(), payload.encode(), "sha256").hexdigest()
    return payload + ":" + sig

def verify_token(token):
    if not token:
        return None
    parts = token.rsplit(":", 1)
    if len(parts) != 2:
        return None
    payload, sig = parts
    expected = hmac.new(SECRET.encode(), payload.encode(), "sha256").hexdigest()
    if not secrets.compare_digest(sig, expected):
        return None
    p = payload.split(":")
    return {"user_id": int(p[0]), "is_admin": p[1] == "True"}

def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def json_response(handler, data, status=200):
    body = json.dumps(data, default=str).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", len(body))
    handler.end_headers()
    handler.wfile.write(body)

def read_body(handler):
    length = int(handler.headers.get("Content-Length", 0))
    if length == 0:
        return {}
    return json.loads(handler.rfile.read(length))

def get_user(handler):
    cookie = handler.headers.get("Cookie", "")
    token = None
    for c in cookie.split(";"):
        c = c.strip()
        if c.startswith("token="):
            token = c[6:]
    if not token:
        auth = handler.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth[7:]
    return verify_token(token)


# ── Database Setup ───────────────────────────────────────────────────────

def init_db():
    conn = db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE NOT NULL,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            is_admin INTEGER DEFAULT 0,
            fav_team_id INTEGER REFERENCES teams(id),
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS teams (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            short_name TEXT NOT NULL,
            color TEXT DEFAULT '#1a1a2e'
        );
        CREATE TABLE IF NOT EXISTS rounds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            round_number INTEGER NOT NULL,
            name TEXT NOT NULL,
            deadline TEXT NOT NULL,
            status TEXT DEFAULT 'upcoming' CHECK(status IN ('upcoming','open','closed','completed'))
        );
        CREATE TABLE IF NOT EXISTS fixtures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            round_id INTEGER NOT NULL REFERENCES rounds(id),
            home_team_id INTEGER NOT NULL REFERENCES teams(id),
            away_team_id INTEGER NOT NULL REFERENCES teams(id),
            home_score INTEGER,
            away_score INTEGER,
            venue TEXT,
            kickoff TEXT,
            status TEXT DEFAULT 'upcoming' CHECK(status IN ('upcoming','completed'))
        );
        CREATE TABLE IF NOT EXISTS tips (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL REFERENCES users(id),
            fixture_id INTEGER NOT NULL REFERENCES fixtures(id),
            predicted_winner_id INTEGER NOT NULL REFERENCES teams(id),
            predicted_margin INTEGER NOT NULL DEFAULT 0,
            points_earned INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            UNIQUE(user_id, fixture_id)
        );
        CREATE TABLE IF NOT EXISTS groups_ (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            code TEXT UNIQUE NOT NULL,
            created_by INTEGER NOT NULL REFERENCES users(id),
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS group_members (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL REFERENCES groups_(id),
            user_id INTEGER NOT NULL REFERENCES users(id),
            UNIQUE(group_id, user_id)
        );
    """)

    # Migration: add fav_team_id if missing
    try:
        conn.execute("SELECT fav_team_id FROM users LIMIT 1")
    except sqlite3.OperationalError:
        conn.execute("ALTER TABLE users ADD COLUMN fav_team_id INTEGER REFERENCES teams(id)")
        conn.commit()
        print("  Migrated: added fav_team_id column")

    # Seed admin if none exists
    admin = conn.execute("SELECT id FROM users WHERE is_admin=1").fetchone()
    if not admin:
        conn.execute(
            "INSERT INTO users (email, display_name, password_hash, is_admin) VALUES (?,?,?,1)",
            ("admin@cmkrugby.co.nz", "Admin", hash_password("admin123"))
        )
        conn.commit()
        print("  Default admin: admin@cmkrugby.co.nz / admin123")

    # Seed teams if empty
    teams = conn.execute("SELECT count(*) c FROM teams").fetchone()["c"]
    if teams == 0:
        taranaki_teams = [
            ("Clifton", "CLI", "#cc0000"),
            ("Coastal", "COA", "#003366"),
            ("Inglewood", "ING", "#006633"),
            ("New Plymouth Old Boys", "NPOB", "#000066"),
            ("Spotswood United", "SPO", "#ffcc00"),
            ("Stratford/Eltham", "S/E", "#660000"),
            ("Tukapa", "TUK", "#004d00"),
            ("Southern", "STH", "#333399"),
            ("Okaiawa", "OKA", "#cc6600"),
            ("Kaponga", "KAP", "#990000"),
        ]
        conn.executemany(
            "INSERT INTO teams (name, short_name, color) VALUES (?,?,?)",
            taranaki_teams
        )
        conn.commit()
        print(f"  Seeded {len(taranaki_teams)} Taranaki teams")

    conn.close()


# ── API Routes ───────────────────────────────────────────────────────────

def api_register(handler):
    data = read_body(handler)
    email = (data.get("email") or "").strip().lower()
    name = (data.get("display_name") or "").strip()
    pw = data.get("password", "")
    fav_team_id = data.get("fav_team_id")
    if not email or not name or len(pw) < 6:
        return json_response(handler, {"error": "Email, name, and password (6+ chars) required"}, 400)
    conn = db()
    try:
        conn.execute(
            "INSERT INTO users (email, display_name, password_hash, fav_team_id) VALUES (?,?,?,?)",
            (email, name, hash_password(pw), fav_team_id)
        )
        conn.commit()
        user = conn.execute("SELECT id, is_admin FROM users WHERE email=?", (email,)).fetchone()
        token = make_token(user["id"], bool(user["is_admin"]))
        return json_response(handler, {"token": token, "user": {"id": user["id"], "display_name": name, "email": email, "is_admin": bool(user["is_admin"])}})
    except sqlite3.IntegrityError:
        return json_response(handler, {"error": "Email already registered"}, 409)
    finally:
        conn.close()

def api_login(handler):
    data = read_body(handler)
    email = (data.get("email") or "").strip().lower()
    pw = data.get("password", "")
    conn = db()
    user = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    conn.close()
    if not user or not check_password(pw, user["password_hash"]):
        return json_response(handler, {"error": "Invalid email or password"}, 401)
    token = make_token(user["id"], bool(user["is_admin"]))
    return json_response(handler, {"token": token, "user": {"id": user["id"], "display_name": user["display_name"], "email": user["email"], "is_admin": bool(user["is_admin"])}})

def api_me(handler):
    u = get_user(handler)
    if not u:
        return json_response(handler, {"error": "Not authenticated"}, 401)
    conn = db()
    user = conn.execute("SELECT id, email, display_name, is_admin FROM users WHERE id=?", (u["user_id"],)).fetchone()
    conn.close()
    if not user:
        return json_response(handler, {"error": "User not found"}, 404)
    return json_response(handler, {"user": dict(user)})

def api_teams(handler):
    conn = db()
    teams = [dict(r) for r in conn.execute("SELECT * FROM teams ORDER BY name").fetchall()]
    conn.close()
    return json_response(handler, teams)

def api_rounds(handler):
    conn = db()
    rounds = [dict(r) for r in conn.execute("SELECT * FROM rounds ORDER BY round_number").fetchall()]
    conn.close()
    return json_response(handler, rounds)

def api_fixtures(handler, round_id=None):
    conn = db()
    if round_id:
        rows = conn.execute("""
            SELECT f.*, ht.name home_team, ht.short_name home_short, ht.color home_color,
                   at.name away_team, at.short_name away_short, at.color away_color
            FROM fixtures f
            JOIN teams ht ON ht.id=f.home_team_id
            JOIN teams at ON at.id=f.away_team_id
            WHERE f.round_id=? ORDER BY f.kickoff
        """, (round_id,)).fetchall()
    else:
        rows = conn.execute("""
            SELECT f.*, ht.name home_team, ht.short_name home_short, ht.color home_color,
                   at.name away_team, at.short_name away_short, at.color away_color,
                   r.round_number, r.name round_name, r.deadline, r.status round_status
            FROM fixtures f
            JOIN teams ht ON ht.id=f.home_team_id
            JOIN teams at ON at.id=f.away_team_id
            JOIN rounds r ON r.id=f.round_id
            ORDER BY r.round_number, f.kickoff
        """).fetchall()
    conn.close()
    return json_response(handler, [dict(r) for r in rows])

def api_submit_tips(handler):
    u = get_user(handler)
    if not u:
        return json_response(handler, {"error": "Not authenticated"}, 401)
    data = read_body(handler)
    tips = data.get("tips", [])
    if not tips:
        return json_response(handler, {"error": "No tips provided"}, 400)
    conn = db()
    for tip in tips:
        fixture = conn.execute("""
            SELECT f.*, r.status round_status, r.deadline
            FROM fixtures f JOIN rounds r ON r.id=f.round_id
            WHERE f.id=?
        """, (tip["fixture_id"],)).fetchone()
        if not fixture:
            continue
        if fixture["round_status"] not in ("upcoming", "open"):
            continue
        # Check deadline
        try:
            dl = datetime.fromisoformat(fixture["deadline"])
            if datetime.now() > dl:
                continue
        except:
            pass
        conn.execute("""
            INSERT INTO tips (user_id, fixture_id, predicted_winner_id, predicted_margin)
            VALUES (?,?,?,?)
            ON CONFLICT(user_id, fixture_id) DO UPDATE SET
                predicted_winner_id=excluded.predicted_winner_id,
                predicted_margin=excluded.predicted_margin
        """, (u["user_id"], tip["fixture_id"], tip["predicted_winner_id"], tip.get("predicted_margin", 0)))
    conn.commit()
    conn.close()
    return json_response(handler, {"success": True})

def api_my_tips(handler, round_id):
    u = get_user(handler)
    if not u:
        return json_response(handler, {"error": "Not authenticated"}, 401)
    conn = db()
    tips = [dict(r) for r in conn.execute("""
        SELECT t.*, f.home_team_id, f.away_team_id
        FROM tips t JOIN fixtures f ON f.id=t.fixture_id
        WHERE t.user_id=? AND f.round_id=?
    """, (u["user_id"], round_id)).fetchall()]
    conn.close()
    return json_response(handler, tips)

def api_leaderboard(handler):
    conn = db()
    rows = [dict(r) for r in conn.execute("""
        SELECT u.id, u.display_name,
               COALESCE(SUM(t.points_earned), 0) total_points,
               COUNT(t.id) total_tips,
               SUM(CASE WHEN t.points_earned > 0 THEN 1 ELSE 0 END) correct_tips
        FROM users u
        LEFT JOIN tips t ON t.user_id=u.id
        WHERE u.is_admin=0
        GROUP BY u.id
        ORDER BY total_points DESC, correct_tips DESC
    """).fetchall()]
    conn.close()
    return json_response(handler, rows)

def api_group_leaderboard(handler, group_id):
    u = get_user(handler)
    if not u:
        return json_response(handler, {"error": "Not authenticated"}, 401)
    conn = db()
    rows = [dict(r) for r in conn.execute("""
        SELECT u.id, u.display_name,
               COALESCE(SUM(t.points_earned), 0) total_points,
               COUNT(t.id) total_tips,
               SUM(CASE WHEN t.points_earned > 0 THEN 1 ELSE 0 END) correct_tips
        FROM group_members gm
        JOIN users u ON u.id=gm.user_id
        LEFT JOIN tips t ON t.user_id=u.id
        WHERE gm.group_id=?
        GROUP BY u.id
        ORDER BY total_points DESC, correct_tips DESC
    """, (group_id,)).fetchall()]
    conn.close()
    return json_response(handler, rows)

def api_create_group(handler):
    u = get_user(handler)
    if not u:
        return json_response(handler, {"error": "Not authenticated"}, 401)
    data = read_body(handler)
    name = (data.get("name") or "").strip()
    if not name:
        return json_response(handler, {"error": "Group name required"}, 400)
    code = secrets.token_hex(3).upper()
    conn = db()
    conn.execute("INSERT INTO groups_ (name, code, created_by) VALUES (?,?,?)", (name, code, u["user_id"]))
    gid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.execute("INSERT INTO group_members (group_id, user_id) VALUES (?,?)", (gid, u["user_id"]))
    conn.commit()
    conn.close()
    return json_response(handler, {"id": gid, "name": name, "code": code})

def api_join_group(handler):
    u = get_user(handler)
    if not u:
        return json_response(handler, {"error": "Not authenticated"}, 401)
    data = read_body(handler)
    code = (data.get("code") or "").strip().upper()
    conn = db()
    group = conn.execute("SELECT * FROM groups_ WHERE code=?", (code,)).fetchone()
    if not group:
        conn.close()
        return json_response(handler, {"error": "Invalid group code"}, 404)
    try:
        conn.execute("INSERT INTO group_members (group_id, user_id) VALUES (?,?)", (group["id"], u["user_id"]))
        conn.commit()
    except sqlite3.IntegrityError:
        pass
    conn.close()
    return json_response(handler, {"success": True, "group": dict(group)})

def api_my_groups(handler):
    u = get_user(handler)
    if not u:
        return json_response(handler, {"error": "Not authenticated"}, 401)
    conn = db()
    groups = [dict(r) for r in conn.execute("""
        SELECT g.*, (SELECT COUNT(*) FROM group_members WHERE group_id=g.id) member_count
        FROM groups_ g
        JOIN group_members gm ON gm.group_id=g.id
        WHERE gm.user_id=?
        ORDER BY g.name
    """, (u["user_id"],)).fetchall()]
    conn.close()
    return json_response(handler, groups)


# ── Admin API ────────────────────────────────────────────────────────────

def require_admin(handler):
    u = get_user(handler)
    if not u or not u["is_admin"]:
        json_response(handler, {"error": "Admin access required"}, 403)
        return None
    return u

def admin_users(handler):
    if not require_admin(handler): return
    conn = db()
    users = [dict(r) for r in conn.execute("SELECT id, email, display_name, is_admin, created_at FROM users ORDER BY display_name").fetchall()]
    conn.close()
    return json_response(handler, users)

def admin_create_round(handler):
    if not require_admin(handler): return
    data = read_body(handler)
    conn = db()
    conn.execute(
        "INSERT INTO rounds (round_number, name, deadline, status) VALUES (?,?,?,?)",
        (data["round_number"], data["name"], data["deadline"], data.get("status", "upcoming"))
    )
    conn.commit()
    rid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()
    return json_response(handler, {"id": rid}, 201)

def admin_update_round(handler, round_id):
    if not require_admin(handler): return
    data = read_body(handler)
    conn = db()
    sets = []
    vals = []
    for k in ("name", "deadline", "status", "round_number"):
        if k in data:
            sets.append(f"{k}=?")
            vals.append(data[k])
    if sets:
        vals.append(round_id)
        conn.execute(f"UPDATE rounds SET {','.join(sets)} WHERE id=?", vals)
        conn.commit()
    conn.close()
    return json_response(handler, {"success": True})

def admin_create_fixture(handler):
    if not require_admin(handler): return
    data = read_body(handler)
    conn = db()
    conn.execute(
        "INSERT INTO fixtures (round_id, home_team_id, away_team_id, venue, kickoff) VALUES (?,?,?,?,?)",
        (data["round_id"], data["home_team_id"], data["away_team_id"], data.get("venue",""), data.get("kickoff",""))
    )
    conn.commit()
    fid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.close()
    return json_response(handler, {"id": fid}, 201)

def admin_enter_result(handler, fixture_id):
    if not require_admin(handler): return
    data = read_body(handler)
    home_score = data["home_score"]
    away_score = data["away_score"]
    conn = db()
    conn.execute(
        "UPDATE fixtures SET home_score=?, away_score=?, status='completed' WHERE id=?",
        (home_score, away_score, fixture_id)
    )
    # Calculate points for all tips on this fixture
    # Margin categories: 0 = draw, 1-12 = 1-12, 13+ = 13+
    # Frontend sends: draw=0, 1-12=7, 13+=20
    fixture = conn.execute("SELECT * FROM fixtures WHERE id=?", (fixture_id,)).fetchone()
    actual_margin = abs(home_score - away_score)
    is_draw = (home_score == away_score)
    actual_winner = None if is_draw else (fixture["home_team_id"] if home_score > away_score else fixture["away_team_id"])

    # Determine actual margin category
    if is_draw:
        actual_cat = "draw"
    elif actual_margin <= 12:
        actual_cat = "1-12"
    else:
        actual_cat = "13+"

    tips = conn.execute("SELECT * FROM tips WHERE fixture_id=?", (fixture_id,)).fetchall()
    for tip in tips:
        points = 0
        pred_margin = tip["predicted_margin"]
        # Determine predicted category from stored number
        if pred_margin == 0:
            pred_cat = "draw"
        elif pred_margin <= 12:
            pred_cat = "1-12"
        else:
            pred_cat = "13+"

        if is_draw and pred_cat == "draw":
            # Predicted draw correctly
            points = 5  # 2 (correct result) + 3 (correct margin category)
        elif not is_draw and tip["predicted_winner_id"] == actual_winner:
            points = 2  # Correct winner
            if pred_cat == actual_cat:
                points += 3  # Correct margin category bonus
        conn.execute("UPDATE tips SET points_earned=? WHERE id=?", (points, tip["id"]))
    conn.commit()
    conn.close()
    return json_response(handler, {"success": True})

def admin_create_team(handler):
    if not require_admin(handler): return
    data = read_body(handler)
    conn = db()
    try:
        conn.execute("INSERT INTO teams (name, short_name, color) VALUES (?,?,?)",
                      (data["name"], data["short_name"], data.get("color", "#1a1a2e")))
        conn.commit()
        tid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.close()
        return json_response(handler, {"id": tid}, 201)
    except sqlite3.IntegrityError:
        conn.close()
        return json_response(handler, {"error": "Team already exists"}, 409)

def admin_update_team(handler, team_id):
    if not require_admin(handler): return
    data = read_body(handler)
    conn = db()
    sets, vals = [], []
    for k in ("name", "short_name", "color"):
        if k in data:
            sets.append(f"{k}=?")
            vals.append(data[k])
    if sets:
        vals.append(team_id)
        conn.execute(f"UPDATE teams SET {','.join(sets)} WHERE id=?", vals)
        conn.commit()
    conn.close()
    return json_response(handler, {"success": True})

def admin_delete_team(handler, team_id):
    if not require_admin(handler): return
    conn = db()
    conn.execute("DELETE FROM teams WHERE id=?", (team_id,))
    conn.commit()
    conn.close()
    return json_response(handler, {"success": True})

def admin_delete_user(handler, user_id):
    if not require_admin(handler): return
    conn = db()
    conn.execute("DELETE FROM tips WHERE user_id=?", (user_id,))
    conn.execute("DELETE FROM group_members WHERE user_id=?", (user_id,))
    conn.execute("DELETE FROM users WHERE id=? AND is_admin=0", (user_id,))
    conn.commit()
    conn.close()
    return json_response(handler, {"success": True})

def admin_toggle_admin(handler, user_id):
    if not require_admin(handler): return
    conn = db()
    conn.execute("UPDATE users SET is_admin = CASE WHEN is_admin=1 THEN 0 ELSE 1 END WHERE id=?", (user_id,))
    conn.commit()
    conn.close()
    return json_response(handler, {"success": True})


# ── Request Handler ──────────────────────────────────────────────────────

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=os.path.join(os.path.dirname(__file__), "public"), **kwargs)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        routes = {
            "/api/me": api_me,
            "/api/teams": api_teams,
            "/api/rounds": api_rounds,
            "/api/fixtures": api_fixtures,
            "/api/leaderboard": api_leaderboard,
            "/api/groups": api_my_groups,
            "/api/admin/users": admin_users,
        }

        if path in routes:
            return routes[path](self)

        # Parameterized GET routes
        m = re.match(r"/api/fixtures/round/(\d+)", path)
        if m:
            return api_fixtures(self, int(m.group(1)))

        m = re.match(r"/api/tips/round/(\d+)", path)
        if m:
            return api_my_tips(self, int(m.group(1)))

        m = re.match(r"/api/groups/(\d+)/leaderboard", path)
        if m:
            return api_group_leaderboard(self, int(m.group(1)))

        # SPA fallback — serve index.html for non-file, non-api routes
        if not path.startswith("/api/") and "." not in path.split("/")[-1]:
            self.path = "/index.html"

        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path

        routes = {
            "/api/register": api_register,
            "/api/login": api_login,
            "/api/tips": api_submit_tips,
            "/api/groups/create": api_create_group,
            "/api/groups/join": api_join_group,
            "/api/admin/rounds": admin_create_round,
            "/api/admin/fixtures": admin_create_fixture,
            "/api/admin/teams": admin_create_team,
        }

        if path in routes:
            return routes[path](self)

        return json_response(self, {"error": "Not found"}, 404)

    def do_PUT(self):
        path = urlparse(self.path).path

        m = re.match(r"/api/admin/rounds/(\d+)", path)
        if m:
            return admin_update_round(self, int(m.group(1)))

        m = re.match(r"/api/admin/fixtures/(\d+)/result", path)
        if m:
            return admin_enter_result(self, int(m.group(1)))

        m = re.match(r"/api/admin/teams/(\d+)", path)
        if m:
            return admin_update_team(self, int(m.group(1)))

        m = re.match(r"/api/admin/users/(\d+)/toggle-admin", path)
        if m:
            return admin_toggle_admin(self, int(m.group(1)))

        return json_response(self, {"error": "Not found"}, 404)

    def do_DELETE(self):
        path = urlparse(self.path).path

        m = re.match(r"/api/admin/teams/(\d+)", path)
        if m:
            return admin_delete_team(self, int(m.group(1)))

        m = re.match(r"/api/admin/users/(\d+)", path)
        if m:
            return admin_delete_user(self, int(m.group(1)))

        return json_response(self, {"error": "Not found"}, 404)

    def log_message(self, format, *args):
        # Quieter logging
        if "/api/" in (args[0] if args else ""):
            print(f"  API: {args[0]}")


# ── Main ─────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("╔══════════════════════════════════════╗")
    print("║   CMK Club Rugby Tipping — Taranaki  ║")
    print("╚══════════════════════════════════════╝")
    init_db()
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"\n  → Running on http://localhost:{PORT}")
    print(f"  → Admin panel at http://localhost:{PORT}/admin.html\n")
    server.serve_forever()
