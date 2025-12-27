import mongoose from "mongoose";

const DuelSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  xpToday: { type: Number, default: 0 },
  xpWindow: { type: Number, default: 0 }, // day window tracker
  duelOpponents: { type: Map, of: { type: Number, default: 0 }, default: {} }, // userId -> count (resets daily)
  duelWindow: { type: Number, default: 0 }, // day window tracker for duel opponent limits
});

export default mongoose.models.Duel || mongoose.model("Duel", DuelSchema);
