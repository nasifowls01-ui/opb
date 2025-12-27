import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import Inventory from "../models/Inventory.js";

export const data = new SlashCommandBuilder().setName("inventory").setDescription("View your inventory/items");
export const aliases = ["inv"];

export async function execute(interactionOrMessage, client) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;

  let inv = await Inventory.findOne({ userId });
  if (!inv) {
    inv = new Inventory({ userId, items: { reset_token: 5 }, chests: { C:0, B:0, A:0, S:0 }, xpBottles: 0 });
    await inv.save();
  }

  const embed = new EmbedBuilder()
    .setTitle(`${user.username}'s Inventory`)
    .setColor(0xFFFFFF)
    .setThumbnail(user.displayAvatarURL());

  const lines = [];
  const chests = inv.chests || { C:0, B:0, A:0, S:0 };
  if ((chests.C || 0) > 0) lines.push(`**C Tier Chest** (${chests.C})`);
  if ((chests.B || 0) > 0) lines.push(`**B Tier Chest** (${chests.B})`);
  if ((chests.A || 0) > 0) lines.push(`**A Tier Chest** (${chests.A})`);
  if ((chests.S || 0) > 0) lines.push(`**S Tier Chest** (${chests.S})`);

  const scrollCount = (inv.xpScrolls > 0) ? inv.xpScrolls : ((inv.xpBottles || 0) > 0 ? inv.xpBottles : 0);
  if (scrollCount > 0) lines.push(`**XP scroll** (${scrollCount})`);
  if ((inv.xpBooks || 0) > 0) lines.push(`**XP book** (${inv.xpBooks})`);

  // list other items (exclude reset_token which is stored on Balance)
  if (inv.items) {
    const entries = (typeof inv.items.get === 'function') ? Array.from(inv.items.entries()) : Object.entries(inv.items || {});
    for (const [k, v] of entries) {
      if (!v) continue;
      if (k === 'reset_token') continue;
      if (k === 'xp_scroll' || k === 'xp_bottle') continue;
      // don't duplicate chest counts or xpBottles
      if (['C','B','A','S'].includes(k)) continue;
      lines.push(`**${k}** (x${v})`);
    }
  }

  if (lines.length === 0) embed.setDescription("You currently have no inventory items.");
  else embed.setDescription(lines.join("\n"));

  if (isInteraction) return interactionOrMessage.reply({ embeds: [embed] });
  return channel.send({ embeds: [embed] });
}
