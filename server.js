const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { state, save } = require("./db");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const ADMIN_KEY = process.env.ADMIN_KEY || "admin123";
const FREE_SUBSCRIPTION_DAYS = 365;

function subscriptionInfo(p) {
  const now = Date.now();
  const end = p.subscription_end ? new Date(p.subscription_end).getTime() : null;
  const expired = end ? now > end : false;
  const daysLeft = end ? Math.max(0, Math.ceil((end - now) / 86400000)) : null;
  return {
    subscription_start: p.subscription_start || null,
    subscription_end: p.subscription_end || null,
    active: p.active !== false,
    expired,
    days_left: daysLeft,
  };
}
function stripPrivate(p) {
  const { password_hash, ...rest } = p;
  return { ...rest, ...subscriptionInfo(p) };
}
function isLive(p) {
  const now = Date.now();
  const end = p.subscription_end ? new Date(p.subscription_end).getTime() : null;
  return p.active !== false && (!end || now <= end);
}

function ratingOf(providerId) {
  const rs = state.reviews.filter((r) => r.provider_id === providerId);
  const cnt = rs.length;
  const avg = cnt ? rs.reduce((a, r) => a + r.rating, 0) / cnt : 0;
  return { rating: Math.round(avg * 10) / 10, reviewCount: cnt };
}
function withRating(p) {
  return { ...stripPrivate(p), ...ratingOf(p.id) };
}

app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- providers (tutors + centers): public search ----------
app.get("/api/providers", (req, res) => {
  const q = (req.query.q || "").trim().toLowerCase();
  const country = (req.query.country || "").trim();
  const mode = (req.query.mode || "").trim(); // online | in_person | both
  const groupType = (req.query.group_type || "").trim(); // individual | group
  const type = (req.query.type || "").trim(); // tutor | center

  let rows = state.providers.filter((p) => p.status === "approved" && isLive(p)).map(withRating);

  if (q) {
    const words = q.split(/\s+/).filter(Boolean);
    rows = rows.filter((p) => {
      const hay = `${p.name} ${p.subject} ${p.country} ${p.area}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  if (country) rows = rows.filter((p) => p.country === country);
  if (mode) rows = rows.filter((p) => p.mode === mode || p.mode === "both");
  if (groupType) rows = rows.filter((p) => p.group_type === groupType);
  if (type) rows = rows.filter((p) => p.type === type);

  rows.sort((a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount);
  res.json(rows);
});

// ---------- provider detail (+ contact reveal gated by seeker_id) ----------
app.get("/api/providers/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id && x.status === "approved" && isLive(x));
  if (!p) return res.status(404).json({ error: "غير موجود" });
  const full = withRating(p);
  const reviews = state.reviews
    .filter((r) => r.provider_id === id)
    .sort((a, b) => b.id - a.id)
    .map(({ seeker_name, rating, text, created_at }) => ({ seeker_name, rating, text, created_at }));

  let phone = null;
  const seekerId = parseInt(req.query.seeker_id, 10);
  if (seekerId && state.seekers.some((s) => s.id === seekerId)) phone = p.phone;

  res.json({ ...full, phone, reviews });
});

// ---------- provider registration (tutor أو center) - pending review ----------
app.post("/api/providers", (req, res) => {
  const {
    type, name, username, phone, email, country, area, nationality, dob,
    subject, degree, experience_years, mode, group_type, max_students,
    price, payment_method, bio, availability_days, availability_from, availability_to,
    password,
  } = req.body || {};

  if (!["tutor", "center"].includes(type)) {
    return res.status(400).json({ error: "نوع الحساب لازم يكون مدرس أو مركز تعليمي" });
  }
  if (!name || !phone || !email || !country || !nationality || !dob || !subject || !price) {
    return res.status(400).json({ error: "البيانات الأساسية (الاسم، الهاتف، الإيميل، الدولة، الجنسية، تاريخ الميلاد، التخصص، السعر) مطلوبة" });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: "كلمة السر مطلوبة ولازم تكون 6 حروف/أرقام على الأقل" });
  }
  if (state.providers.some((p) => p.phone === phone)) {
    return res.status(409).json({ error: "رقم الهاتف ده مسجل بالفعل" });
  }
  if (state.providers.some((p) => p.email.toLowerCase() === String(email).toLowerCase())) {
    return res.status(409).json({ error: "البريد الإلكتروني ده مسجل بالفعل" });
  }
  if (username && state.providers.some((p) => p.username && p.username.toLowerCase() === String(username).toLowerCase())) {
    return res.status(409).json({ error: "اسم المستخدم ده مستخدم بالفعل" });
  }
  if (!["online", "in_person", "both"].includes(mode)) {
    return res.status(400).json({ error: "طريقة التدريس لازم تكون أونلاين أو حضوري أو الاثنين" });
  }
  if (!["individual", "group"].includes(group_type)) {
    return res.status(400).json({ error: "نوع الدرس لازم يكون فردي أو مجموعة" });
  }
  if (!["transfer", "cash"].includes(payment_method)) {
    return res.status(400).json({ error: "طريقة الدفع لازم تكون تحويل أو نقدي" });
  }

  const p = {
    id: state.nextIds.provider++,
    type, name, username: username || "", phone, email,
    country, area: area || "", nationality, dob,
    subject, degree: degree || "", experience_years: parseInt(experience_years, 10) || 0,
    mode, group_type, max_students: group_type === "group" ? (parseInt(max_students, 10) || 2) : 1,
    price: parseFloat(price) || 0, payment_method, bio: bio || "",
    availability_days: Array.isArray(availability_days) ? availability_days : [],
    availability_from: availability_from || "", availability_to: availability_to || "",
    password_hash: bcrypt.hashSync(String(password), 10),
    subscription_start: null, subscription_end: null, active: true,
    status: "pending", created_at: new Date().toISOString(),
  };
  state.providers.push(p);
  save();
  res.status(201).json({ id: p.id, status: "pending" });
});

// ---------- reviews ----------
app.post("/api/providers/:id/reviews", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id);
  if (!p) return res.status(404).json({ error: "غير موجود" });
  const { seeker_name, rating, text } = req.body || {};
  const r = parseInt(rating, 10);
  if (!r || r < 1 || r > 5) return res.status(400).json({ error: "التقييم لازم يكون من 1 لـ 5" });
  state.reviews.push({
    id: state.nextIds.review++, provider_id: id,
    seeker_name: seeker_name || "ولي أمر", rating: r, text: text || "(بدون تعليق)",
    created_at: new Date().toISOString(),
  });
  save();
  res.status(201).json({ ok: true });
});

// ---------- seekers (parent أو student) ----------
app.post("/api/seekers", (req, res) => {
  const { type, name, username, phone, email, country, area, nationality, dob, children_count } = req.body || {};
  if (!["parent", "student"].includes(type)) {
    return res.status(400).json({ error: "نوع الحساب لازم يكون ولي أمر أو طالب" });
  }
  if (!name || !phone || !country || !nationality || !dob) {
    return res.status(400).json({ error: "الاسم والهاتف والدولة والجنسية وتاريخ الميلاد مطلوبة" });
  }
  if (state.seekers.some((s) => s.phone === phone)) {
    return res.status(409).json({ error: "رقم الهاتف ده مسجل بالفعل" });
  }
  if (email && state.seekers.some((s) => s.email && s.email.toLowerCase() === String(email).toLowerCase())) {
    return res.status(409).json({ error: "البريد الإلكتروني ده مسجل بالفعل" });
  }
  if (username && state.seekers.some((s) => s.username && s.username.toLowerCase() === String(username).toLowerCase())) {
    return res.status(409).json({ error: "اسم المستخدم ده مستخدم بالفعل" });
  }
  const s = {
    id: state.nextIds.seeker++, type, name, username: username || "", phone,
    email: email || "", country, area: area || "", nationality, dob,
    children_count: type === "parent" ? (parseInt(children_count, 10) || 0) : 0,
    created_at: new Date().toISOString(),
  };
  state.seekers.push(s);
  save();
  res.status(201).json({ id: s.id, name: s.name, type: s.type });
});

// ---------- favorites ----------
app.post("/api/seekers/:sid/favorites/:pid", (req, res) => {
  const seeker_id = parseInt(req.params.sid, 10);
  const provider_id = parseInt(req.params.pid, 10);
  if (!state.favorites.some((f) => f.seeker_id === seeker_id && f.provider_id === provider_id)) {
    state.favorites.push({ seeker_id, provider_id });
    save();
  }
  res.json({ ok: true });
});
app.delete("/api/seekers/:sid/favorites/:pid", (req, res) => {
  const seeker_id = parseInt(req.params.sid, 10);
  const provider_id = parseInt(req.params.pid, 10);
  state.favorites = state.favorites.filter((f) => !(f.seeker_id === seeker_id && f.provider_id === provider_id));
  save();
  res.json({ ok: true });
});
app.get("/api/seekers/:sid/favorites", (req, res) => {
  const seeker_id = parseInt(req.params.sid, 10);
  const providerIds = state.favorites.filter((f) => f.seeker_id === seeker_id).map((f) => f.provider_id);
  const rows = state.providers.filter((p) => providerIds.includes(p.id) && p.status === "approved").map(withRating);
  res.json(rows);
});

// ---------- bookings ----------
app.post("/api/bookings", (req, res) => {
  const provider_id = parseInt(req.body.provider_id, 10);
  const seeker_id = parseInt(req.body.seeker_id, 10);
  const provider = state.providers.find((p) => p.id === provider_id && p.status === "approved");
  const seeker = state.seekers.find((s) => s.id === seeker_id);
  if (!provider || !seeker) return res.status(400).json({ error: "بيانات الحجز غير صحيحة" });
  const b = { id: state.nextIds.booking++, provider_id, seeker_id, status: "بانتظار تأكيد المدرس", created_at: new Date().toISOString() };
  state.bookings.push(b);
  save();
  res.status(201).json({ id: b.id });
});
app.get("/api/seekers/:sid/bookings", (req, res) => {
  const seeker_id = parseInt(req.params.sid, 10);
  const rows = state.bookings
    .filter((b) => b.seeker_id === seeker_id)
    .sort((a, b) => b.id - a.id)
    .map((b) => {
      const p = state.providers.find((x) => x.id === b.provider_id) || {};
      return { id: b.id, status: b.status, created_at: b.created_at, provider_name: p.name, subject: p.subject, price: p.price };
    });
  res.json(rows);
});

// ---------- admin ----------
function requireAdmin(req, res, next) {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(401).json({ error: "غير مصرح" });
  next();
}
app.get("/api/admin/providers", requireAdmin, (req, res) => {
  const status = req.query.status || "pending";
  const rows = state.providers.filter((p) => p.status === status).sort((a, b) => b.id - a.id).map(stripPrivate);
  res.json(rows);
});
app.post("/api/admin/providers/:id/approve", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id);
  if (p) {
    p.status = "approved";
    if (!p.subscription_start) {
      p.subscription_start = new Date().toISOString();
      p.subscription_end = new Date(Date.now() + FREE_SUBSCRIPTION_DAYS * 86400000).toISOString();
    }
    p.active = true;
    save();
  }
  res.json({ ok: true });
});
app.post("/api/admin/providers/:id/suspend", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id);
  if (p) { p.active = false; save(); }
  res.json({ ok: true });
});
app.post("/api/admin/providers/:id/activate", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id);
  if (p) { p.active = true; save(); }
  res.json({ ok: true });
});
app.post("/api/admin/providers/:id/reset-password", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id);
  if (!p) return res.status(404).json({ error: "غير موجود" });
  const newPassword = crypto.randomBytes(4).toString("hex"); // 8 حروف
  p.password_hash = bcrypt.hashSync(newPassword, 10);
  save();
  res.json({ ok: true, new_password: newPassword });
});
app.post("/api/admin/providers/:id/reject", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id);
  if (p) { p.status = "rejected"; save(); }
  res.json({ ok: true });
});
app.delete("/api/admin/providers/:id", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  state.providers = state.providers.filter((x) => x.id !== id);
  state.reviews = state.reviews.filter((r) => r.provider_id !== id);
  state.bookings = state.bookings.filter((b) => b.provider_id !== id);
  state.favorites = state.favorites.filter((f) => f.provider_id !== id);
  save();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`نجاح (Nagah) platform running on port ${PORT}`));
