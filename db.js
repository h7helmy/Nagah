// مخزن بيانات بسيط قائم على ملف JSON (بدون اعتماديات native) - مناسب لنموذج MVP حقيقي
const fs = require("fs");
const path = require("path");

const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, "data.json");

function seedData() {
  return {
    nextIds: { provider: 1, seeker: 1, review: 1, booking: 1 },
    // providers: مدرس فردي (tutor) أو مركز تعليمي (center)
    providers: [],
    // seekers: ولي أمر (parent) أو طالب (student)
    seekers: [],
    reviews: [],   // { id, provider_id, name, rating, text, created_at }
    bookings: [],  // { id, provider_id, seeker_id, status, created_at }
    favorites: [], // { seeker_id, provider_id }
  };
}

let state;
if (fs.existsSync(DATA_PATH)) {
  try {
    state = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  } catch (e) {
    state = seedData();
  }
} else {
  state = seedData();
}

function save() {
  fs.writeFileSync(DATA_PATH, JSON.stringify(state, null, 2));
}
if (!fs.existsSync(DATA_PATH)) save();

module.exports = { state, save };
