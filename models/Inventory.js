import mongoose from "mongoose";

const InventorySchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  items: { type: Map, of: Number, default: {} },
  chests: {
    C: { type: Number, default: 0 },
    B: { type: Number, default: 0 },
    A: { type: Number, default: 0 }
    ,S: { type: Number, default: 0 }
  },
  xpBottles: { type: Number, default: 0 },
  xpScrolls: { type: Number, default: 0 },
  xpBooks: { type: Number, default: 0 }
});

export default mongoose.models.Inventory || mongoose.model("Inventory", InventorySchema);
