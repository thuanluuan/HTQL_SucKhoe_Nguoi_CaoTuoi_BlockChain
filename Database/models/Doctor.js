// models/Doctor.js
const mongoose = require("mongoose");

const DoctorSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  email: { type: String, required: true },
  cccd: { type: String, required: true, unique: true },
  dob: String,
  phone: String,
  address: String,
  spec: { type: String, required: true },
  license: String,
  walletAddress: { type: String, unique: true, sparse: true },
  passwordHash: { type: String },
  role: { type: String, default: "doctor" },
  status: { type: String, default: "active" },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Doctor", DoctorSchema);
