import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { fuzzyFindCard } from "../lib/cardEmbed.js";
import Progress from "../models/Progress.js";
import Balance from "../models/Balance.js";

export const data = new SlashCommandBuilder()
  .setName("sell")
  .setDescription("Sell a card for beli")
  .addStringOption(opt => opt.setName("card").setDescription("Card id or name").setRequired(true));

export const category = "Economy";
export const description = "Sell a card for money";

const PRICE_BY_RANK = { C: 50, B: 100, A: 500, S: 1000, SS: 2500, UR: 10000 };

export async function execute(interactionOrMessage, client) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;

  let query;
  if (isInteraction) {
    query = interactionOrMessage.options.getString("card");
  } else {
    const parts = interactionOrMessage.content.trim().split(/\s+/);
    // op sell <card name...>
    query = parts.slice(2).join(" ");
  }

  const card = fuzzyFindCard(query);
  if (!card) {
    const reply = `Card not found: ${query}`;
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  // load progress
  let prog = await Progress.findOne({ userId });
  if (!prog) prog = new Progress({ userId, cards: {} });
  const cardsMap = prog.cards instanceof Map ? prog.cards : new Map(Object.entries(prog.cards || {}));
  const entry = cardsMap.get(card.id) || { count: 0, xp: 0, level: 0 };
  if (!entry || (entry.count || 0) < 1) {
    const reply = `You don't own a copy of **${card.name}**.`;
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  const rank = String(card.rank || "C").toUpperCase();
  const price = PRICE_BY_RANK[rank] || PRICE_BY_RANK.C;

  // decrement card
  entry.count = (entry.count || 0) - 1;
  if (entry.count <= 0) cardsMap.delete(card.id);
  else cardsMap.set(card.id, entry);

  prog.cards = cardsMap;
  prog.markModified('cards');
  await prog.save();

  // add balance
  let bal = await Balance.findOne({ userId });
  if (!bal) bal = new Balance({ userId, amount: 0, resetTokens: 0 });
  bal.amount = (bal.amount || 0) + price;
  await bal.save();

  // Record quest progress for selling items
  try {
    const Quest = (await import("../models/Quest.js")).default;
    const [dailyQuests, weeklyQuests] = await Promise.all([
      Quest.getCurrentQuests("daily"),
      Quest.getCurrentQuests("weekly")
    ]);
    await Promise.all([
      dailyQuests.recordAction(userId, "sell", 1),
      weeklyQuests.recordAction(userId, "sell", 1)
    ]);
  } catch (e) {
    console.error("Failed to record sell quest progress:", e);
  }

  const embed = new EmbedBuilder()
    .setTitle("Card Sold")
    .setColor(0x2ecc71)
    .setDescription(`${card.name} — ${card.title || ""}\n\nYou sold 1× ${card.name} for ${price}¥.`)
    .setFooter({ text: `New balance: ${bal.amount}¥`, iconURL: user.displayAvatarURL() });

  if (isInteraction) return interactionOrMessage.reply({ embeds: [embed] });
  return channel.send({ embeds: [embed] });
}
