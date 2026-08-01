const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { state, save } = require("./db");
const { sendMail } = require("./mailer");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const ADMIN_KEY = process.env.ADMIN_KEY || "admin123";
const FREE_SUBSCRIPTION_DAYS = 365;
const FREE_TUTOR_LIMIT = 100; // أول 100 معلم/معلمة بياخدوا سنة مجانية أوتوماتيك

// إنشاء حساب سوبر أدمن افتراضي أول مرة (لو مفيش حساب سوبر أدمن محفوظ خالص)
if (state.admins.length === 0) {
  const seedUsername = process.env.SUPER_ADMIN_USERNAME || "01030422228";
  const seedPassword = process.env.SUPER_ADMIN_PASSWORD || "admin0115302197";
  state.admins.push({
    username: seedUsername,
    password_hash: bcrypt.hashSync(seedPassword, 10),
    created_at: new Date().toISOString(),
  });
  save();
}

function freeTutorSlotsUsed() {
  return state.providers.filter((x) => x.type === "tutor" && x.subscription_start).length;
}

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
function stripPrivateSeeker(s) {
  const { password_hash, ...rest } = s;
  return { ...rest, active: s.active !== false };
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
  const stage = (req.query.stage || "").trim();

  let rows = state.providers.filter((p) => p.status === "approved" && isLive(p)).map(withRating);

  if (q) {
    const words = q.split(/\s+/).filter(Boolean);
    rows = rows.filter((p) => {
      const hay = `${p.name} ${p.subject} ${p.stage} ${p.country} ${p.area}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }
  if (stage) rows = rows.filter((p) => p.stage === stage);
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
  let can_review = false;
  const seekerId = parseInt(req.query.seeker_id, 10);
  if (seekerId && state.seekers.some((s) => s.id === seekerId)) {
    phone = p.phone;
    const hasConfirmedBooking = state.bookings.some((b) => b.provider_id === id && b.seeker_id === seekerId && b.status === "confirmed");
    const alreadyReviewed = state.reviews.some((r) => r.provider_id === id && r.seeker_id === seekerId);
    can_review = hasConfirmedBooking && !alreadyReviewed;
  }

  res.json({ ...full, phone, can_review, reviews });
});

// ---------- provider registration (tutor أو center) - pending review ----------
app.post("/api/providers", (req, res) => {
  const {
    type, name, username, phone, email, country, area, nationality, dob,
    stage, subject, degree, experience_years, mode, group_type, max_students,
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
    stage: stage || "", subject, degree: degree || "", experience_years: parseInt(experience_years, 10) || 0,
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

// ---------- provider self dashboard ----------
app.get("/api/providers/:id/me", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id);
  if (!p) return res.status(404).json({ error: "غير موجود" });
  res.json(stripPrivate(p));
});
app.get("/api/providers/:id/bookings", (req, res) => {
  const provider_id = parseInt(req.params.id, 10);
  const rows = state.bookings
    .filter((b) => b.provider_id === provider_id)
    .sort((a, b) => b.id - a.id)
    .map((b) => {
      const s = state.seekers.find((x) => x.id === b.seeker_id) || {};
      return { id: b.id, status: b.status, status_label: bookingStatusLabel(b.status), created_at: b.created_at, seeker_name: s.name, seeker_phone: s.phone };
    });
  res.json(rows);
});

// ---------- reviews (مقفولة على حجز مؤكد فقط عشان تكون التقييمات موثوقة) ----------
app.post("/api/providers/:id/reviews", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id);
  if (!p) return res.status(404).json({ error: "غير موجود" });
  const { seeker_id, rating, text } = req.body || {};
  const seekerId = parseInt(seeker_id, 10);
  const seeker = state.seekers.find((s) => s.id === seekerId);
  if (!seeker) return res.status(401).json({ error: "لازم تسجّل دخولك كولي أمر أو طالب الأول عشان تقيّم" });
  const hasConfirmedBooking = state.bookings.some((b) => b.provider_id === id && b.seeker_id === seekerId && b.status === "confirmed");
  if (!hasConfirmedBooking) return res.status(403).json({ error: "التقييم متاح بس بعد ما المدرس يأكد حجزك معاه" });
  if (state.reviews.some((r) => r.provider_id === id && r.seeker_id === seekerId)) {
    return res.status(409).json({ error: "أنت قيّمت المدرس ده قبل كده" });
  }
  const r = parseInt(rating, 10);
  if (!r || r < 1 || r > 5) return res.status(400).json({ error: "التقييم لازم يكون من 1 لـ 5" });
  state.reviews.push({
    id: state.nextIds.review++, provider_id: id, seeker_id: seekerId,
    seeker_name: seeker.name, rating: r, text: text || "(بدون تعليق)",
    created_at: new Date().toISOString(),
  });
  save();
  res.status(201).json({ ok: true });
});

// ---------- seekers (parent أو student) ----------
app.post("/api/seekers", (req, res) => {
  const { type, name, username, phone, email, country, area, nationality, dob, children_count, password } = req.body || {};
  if (!["parent", "student"].includes(type)) {
    return res.status(400).json({ error: "نوع الحساب لازم يكون ولي أمر أو طالب" });
  }
  if (!name || !phone || !country || !nationality || !dob) {
    return res.status(400).json({ error: "الاسم والهاتف والدولة والجنسية وتاريخ الميلاد مطلوبة" });
  }
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: "كلمة السر مطلوبة ولازم تكون 6 حروف/أرقام على الأقل" });
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
    password_hash: bcrypt.hashSync(String(password), 10),
    active: true,
    created_at: new Date().toISOString(),
  };
  state.seekers.push(s);
  save();
  res.status(201).json(stripPrivateSeeker(s));
});

// ---------- unified login (provider أو seeker) ----------
app.post("/api/login", (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: "رقم الهاتف وكلمة السر مطلوبان" });
  const p = state.providers.find((x) => x.phone === phone);
  if (p && bcrypt.compareSync(String(password), p.password_hash)) {
    if (p.active === false) return res.status(403).json({ error: "الحساب موقوف حاليًا من الإدارة" });
    return res.json({ kind: "provider", ...stripPrivate(p) });
  }
  const s = state.seekers.find((x) => x.phone === phone);
  if (s && bcrypt.compareSync(String(password), s.password_hash)) {
    if (s.active === false) return res.status(403).json({ error: "الحساب موقوف حاليًا من الإدارة" });
    return res.json({ kind: "seeker", ...stripPrivateSeeker(s) });
  }
  res.status(401).json({ error: "رقم الهاتف أو كلمة السر غلط" });
});

// نسيت كلمة السر: بعتلك كلمة سر جديدة على الإيميل المسجل (لو موجود) - نفس الرد دايمًا عشان محدش يعرف مين مسجل
app.post("/api/forgot-password", async (req, res) => {
  const generic = { ok: true, message: "لو رقم الهاتف ده مسجل وعنده إيميل، هيوصله كلمة سر جديدة على الإيميل خلال دقايق" };
  const { phone } = req.body || {};
  if (!phone) return res.json(generic);
  const account = state.providers.find((x) => x.phone === phone) || state.seekers.find((x) => x.phone === phone);
  if (!account || !account.email) return res.json(generic);
  const newPassword = crypto.randomBytes(4).toString("hex");
  account.password_hash = bcrypt.hashSync(newPassword, 10);
  save();
  try {
    await sendMail({
      to: account.email,
      subject: "كلمة السر الجديدة - منصة نجاح",
      text: `أهلًا ${account.name}،\n\nطلبت استرجاع كلمة السر لحسابك على منصة نجاح.\nكلمة السر الجديدة هي: ${newPassword}\n\nتقدر تسجّل دخولك بيها دلوقتي.\n\nمنصة نجاح`,
    });
  } catch (e) {
    console.error("فشل إرسال إيميل استرجاع كلمة السر:", e.message);
  }
  res.json(generic);
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
  const b = { id: state.nextIds.booking++, provider_id, seeker_id, status: "pending", created_at: new Date().toISOString() };
  state.bookings.push(b);
  save();
  res.status(201).json({ id: b.id });
});
function bookingStatusLabel(status) {
  return status === "confirmed" ? "✅ تم تأكيد الحجز" : status === "cancelled" ? "❌ ملغي" : "⏳ بانتظار تأكيد المدرس";
}
// المدرس/المركز بيأكد أو يلغي طلب الحجز - التأكيد هو اللي بيفتح الباب لولي الأمر/الطالب عشان يقيّم بعد كده
app.post("/api/bookings/:id/confirm", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const providerId = parseInt(req.body.provider_id, 10);
  const b = state.bookings.find((x) => x.id === id && x.provider_id === providerId);
  if (!b) return res.status(404).json({ error: "غير موجود" });
  b.status = "confirmed";
  save();
  res.json({ ok: true });
});
app.post("/api/bookings/:id/cancel", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const providerId = parseInt(req.body.provider_id, 10);
  const b = state.bookings.find((x) => x.id === id && x.provider_id === providerId);
  if (!b) return res.status(404).json({ error: "غير موجود" });
  b.status = "cancelled";
  save();
  res.json({ ok: true });
});
app.get("/api/seekers/:sid/bookings", (req, res) => {
  const seeker_id = parseInt(req.params.sid, 10);
  const rows = state.bookings
    .filter((b) => b.seeker_id === seeker_id)
    .sort((a, b) => b.id - a.id)
    .map((b) => {
      const p = state.providers.find((x) => x.id === b.provider_id) || {};
      return { id: b.id, status: b.status, status_label: bookingStatusLabel(b.status), created_at: b.created_at, provider_name: p.name, subject: p.subject, price: p.price };
    });
  res.json(rows);
});

// ---------- admin ----------
function requireAdmin(req, res, next) {
  if (req.headers["x-admin-key"] !== ADMIN_KEY) return res.status(401).json({ error: "غير مصرح" });
  next();
}
app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  const admin = state.admins.find((a) => a.username === username);
  if (!admin || !bcrypt.compareSync(password || "", admin.password_hash)) {
    return res.status(401).json({ error: "بيانات الدخول غير صحيحة" });
  }
  res.json({ ok: true, username: admin.username, admin_key: ADMIN_KEY });
});
app.post("/api/admin/change-password", requireAdmin, (req, res) => {
  const { username, new_password } = req.body || {};
  const admin = state.admins.find((a) => a.username === username);
  if (!admin) return res.status(404).json({ error: "الحساب غير موجود" });
  if (!new_password || new_password.length < 6) return res.status(400).json({ error: "كلمة السر لازم تكون 6 حروف/أرقام على الأقل" });
  admin.password_hash = bcrypt.hashSync(new_password, 10);
  save();
  res.json({ ok: true });
});
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
    let gotFreeYear = false;
    if (!p.subscription_start) {
      if (p.type === "center" || (p.type === "tutor" && freeTutorSlotsUsed() < FREE_TUTOR_LIMIT)) {
        p.subscription_start = new Date().toISOString();
        p.subscription_end = new Date(Date.now() + FREE_SUBSCRIPTION_DAYS * 86400000).toISOString();
        gotFreeYear = true;
      }
    }
    p.active = true;
    save();
    return res.json({ ok: true, got_free_year: gotFreeYear });
  }
  res.json({ ok: true });
});
app.post("/api/admin/providers/:id/set-subscription", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const p = state.providers.find((x) => x.id === id);
  if (!p) return res.status(404).json({ error: "غير موجود" });
  const months = parseInt(req.body.months, 10);
  if (!months || months < 1) return res.status(400).json({ error: "عدد الشهور غير صحيح" });
  p.subscription_start = new Date().toISOString();
  p.subscription_end = new Date(Date.now() + months * 30 * 86400000).toISOString();
  p.active = true;
  save();
  res.json({ ok: true, subscription_end: p.subscription_end });
});
app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const used = freeTutorSlotsUsed();
  res.json({
    free_tutor_limit: FREE_TUTOR_LIMIT,
    free_tutor_slots_used: used,
    free_tutor_slots_left: Math.max(0, FREE_TUTOR_LIMIT - used),
  });
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

// ---------- admin: seekers (أولياء الأمور والطلاب) ----------
app.get("/api/admin/seekers", requireAdmin, (req, res) => {
  const type = req.query.type || "";
  let rows = state.seekers.slice().sort((a, b) => b.id - a.id);
  if (type) rows = rows.filter((s) => s.type === type);
  res.json(rows.map(stripPrivateSeeker));
});
app.post("/api/admin/seekers/:id/suspend", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const s = state.seekers.find((x) => x.id === id);
  if (s) { s.active = false; save(); }
  res.json({ ok: true });
});
app.post("/api/admin/seekers/:id/activate", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const s = state.seekers.find((x) => x.id === id);
  if (s) { s.active = true; save(); }
  res.json({ ok: true });
});
app.post("/api/admin/seekers/:id/reset-password", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const s = state.seekers.find((x) => x.id === id);
  if (!s) return res.status(404).json({ error: "غير موجود" });
  const newPassword = crypto.randomBytes(4).toString("hex");
  s.password_hash = bcrypt.hashSync(newPassword, 10);
  save();
  res.json({ ok: true, new_password: newPassword });
});
app.delete("/api/admin/seekers/:id", requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  state.seekers = state.seekers.filter((x) => x.id !== id);
  state.bookings = state.bookings.filter((b) => b.seeker_id !== id);
  state.favorites = state.favorites.filter((f) => f.seeker_id !== id);
  save();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`نجاح (Nagah) platform running on port ${PORT}`));
