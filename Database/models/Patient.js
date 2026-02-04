// models/Patient.js
const mongoose = require("mongoose");

const PatientSchema = new mongoose.Schema({
  cccd: { type: String, required: true, unique: true },
  fullName: { type: String, required: true },
  birthDate: { type: String }, // Lưu dạng chuỗi hoặc Date
  phone: String,
  address: String,
  vitalSigns: {
    heightCm: Number,
    weightKg: Number,
    bloodPressure: String,
    heartRate: Number,
  },
  medicalHistory: String,
  patientIndexKey: { type: String, default: null },
  blockchainHash: { type: String, default: "" },
  isVerified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Patient", PatientSchema);
