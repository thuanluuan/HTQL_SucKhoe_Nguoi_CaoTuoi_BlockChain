// models/ChainSyncState.js
const mongoose = require("mongoose");

const ChainSyncStateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  lastBlock: { type: Number, default: 0 },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("ChainSyncState", ChainSyncStateSchema);
