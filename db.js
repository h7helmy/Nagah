// مخزن بيانات بسيط قائم على ملف JSON (بدون اعتماديات native) - مناسب لنموذج MVP حقيقي
const fs = require("fs");
const path = require("path");

const DATA_PATH = process.env.DATA_PATH || path.join(__dirname, "data.json");

function seedData() {
  return {
    nextIds: { tutor: 1, parent: 1, review: 1, booking: 1 },
    tutors: [],
    parents: [],
    reviews: [],
    bookings: [],
    favorites: [], // { parent_id, tutor_id }
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
