const express = require("express");
const path = require("path");
const { state, save } = require("./db");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const ADMIN_KEY = process.env.ADMIN_KEY || "admin123";

function ratingOf(tutorId) {
  const rs = state.reviews.filter((r) => r.tutor_id === tutorId);
  const cnt = rs.length;
  const avg = cnt ? rs.reduce((a, r) => a + r.rating, 0) / cnt : 0;
  return { rating: Math.round(avg * 10) / 10, reviewCount: cnt };
}
function withRating(t) {
  return { ...t, ...ratingOf(t.id) };
}

app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- tutors: public search ----------
app.get("/api/tutors", (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  let rows = state.tutors.filter((t) => t.status === "approved").map(withRating);
  if (q) {
    const words = q.split(/\s+/).filter(Boolean);
    rows = rows.filter((t) => {
      const hay = `${t.name} ${t.subject} ${t.stage} ${t.area}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  rows.sort((a, b) => b.rating - a.rating);
  res.json(rows);
});

// ---------- tutor detail (+ contact reveal gated by parent_id) ----------
app.get("/api/tutors/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t = state.tutors.find((x) => x.id === id && x.status === "approved");
  if (!t) return res.status(404).json({ error: "غير موجود" });
  const full = withRating(t);
  const reviews = state.reviews
    .filter((r) => r.tutor_id === id)
    .sort((a, b) => b.id - a.id)
    .map(({ parent_name, rating, text, created_at }) => ({ parent_name, rating, text, created_at }));

  let phone = null;
  const parentId = parseInt(req.query.parent_id, 10);
  if (parentId && state.parents.some((p) => p.id === parentId)) phone = t.phone;

  res.json({ ...full, phone, reviews });
});

// ---------- tutor registration (pending review) ----------
app.post("/api/tutors", (req, res) => {
  const { name, subject, stage, area, price, bio, phone } = req.body || {};
  if (!name || !subject || !area || !price || !phone) {
    return res.status(400).json({ error: "الاسم والمادة والمنطقة والسعر والهاتف مطلوبة" });
  }
  const t = {
    id: state.nextIds.tutor++,
    name, subject, stage: stage || "", area,
    price: parseFloat(price) || 0, bio: bio || "", phone,
    status: "pending", created_at: new Date().toISOString(),
  };
  state.tutors.push(t);
  save();
  res.status(201).json({ id: t.id, status: "pending" });
});

// ---------- reviews ----------
app.post("/api/tutors/:id/reviews", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t = state.tutors.find((x) => x.id === id);
  if (!t) return res.status(404).json({ error: "المدرس غير موجود" });
  const { parent_name, rating, text } = req.body || {};
  const r = parseInt(rating, 10);
  if (!r || r < 1 || r > 5) return res.status(400).json({ error: "التقييم لازم يكون من 1 لـ 5" });
  state.reviews.push({
    id: state.nextIds.review++, tutor_id: id,
    parent_name: parent_name || "ولي أمر", rating: r, text: text || "(بدون تعليق)",
    created_at: new Date().toISOString(),
  });
  save();
  res.status(201).json({ ok: true });
});

// ---------- parents ----------
app.post("/api/parents", (req, res) => {
  const { name, phone, area } = req.body || {};
  if (!name || !phone) return res.status(400).json({ error: "الاسم والهاتف مطلوبان" });
  const p = { id: state.nextIds.parent++, name, phone, area: area || "", created_at: new Date().toISOString() };
  state.parents.push(p);
  save();
  res.status(201).json({ id: p.id, name: p.name });
});

// ---------- favorites ----------
app.post("/api/parents/:pid/favorites/:tid", (req, res) => {
  const parent_id = parseInt(req.params.pid, 10);
  const tutor_id = parseInt(req.params.tid, 10);
  if (!state.favorites.some((f) => f.parent_id === parent_id && f.tutor_id === tutor_id)) {
    state.favorites.push({ parent_id, tutor_id });
    save();
  }
  res.json({ ok: true });
});
app.delete("/api/parents/:pid/favorites/:tid", (req, res) => {
  const parent_id = parseInt(req.params.pid, 10);
  const tutor_id = parseInt(req.params.tid, 10);
  state.favorites = state.favorites.filter((f) => !(f.parent_id === parent_id && f.tutor_id === tutor_id));
  save();
  res.json({ ok: true });
});
app.get("/api/parents/:pid/favorites", (req, res) => {
  const parent_id = parseInt(req.params.pid, 10);
  const tutorIds = state.favorites.filter((f) => f.parent_id === parent_id).map((f) => f.tutor_id);
  const rows = state.tutors.filter((t) => tutorIds.includes(t.id) && t.status === "approved").map(withRating);
  res.json(rows);
});

// ---------- bookings ----------
app.post("/api/bookings", (req, res) => {
  const tutor_id = parseInt(req.body.tutor_id, 10);
  const parent_id = parseInt(req.body.parent_id, 10);
  const tutor = state.tutors.find((t) => t.id === tutor_id && t.status === "approved");
  const parent = state.parents.find((p) => p.id === parent_id);
  if (!tutor || !parent) return res.status(400).json({ error: "بيانات الحجز غير صحيحة" });
  const b = { id: state.nextIds.booking++, tutor_id, parent_id, status: "بانتظار تأكيد المدرس", created_at: new Date().toISOString() };
  state.bookings.push(b);
  save();
  res.status(201).json({ id: b.id });
});
app.get("/api/parents/:pid/bookings", (req, res) => {
  const parent_id = parseInt(req.params.pid, 10);
  const rows = state.bookings
    .filter((b) => b.parent_id === parent_id)
    .sort((a, b) => b.id - a.id)
    .map((b) => {
      const t = state.tutors.find((x) => x.id === b.tutor_id) || {};
      return { id: b.id, status: b.status, created_at: b.created_at, tutor_name: t.name, subject: t.subject, price: t.price };
    });
  res.json(rows);
});

// ---------- admin ----------
function requireAdmin(req, res, next) {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(401).json({ error: "غير مصرح" });
  next();
}
app.get("/api/admin/tutors", requireAdmin, (req, res) => {
  const status = req.query.status || "pending";
  const rows = state.tutors.filter((t) => t.status === status).sort((a, b) => b.id - a.id);
  res.json(rows);
});
app.post("/api/admin/tutors/:id/approve", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t = state.tutors.find((x) => x.id === id);
  if (t) { t.status = "approved"; save(); }
  res.json({ ok: true });
});
app.post("/api/admin/tutors/:id/reject", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const t = state.tutors.find((x) => x.id === id);
  if (t) { t.status = "rejected"; save(); }
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`darrisni platform running on port ${PORT}`));
