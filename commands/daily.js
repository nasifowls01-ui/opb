import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import Balance from "../models/Balance.js";
import Inventory from "../models/Inventory.js";

export const data = new SlashCommandBuilder().setName("daily").setDescription("Claim daily rewards (5-day streak)");
export const category = "Economy";
export const description = "Claim daily rewards";

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

export async function execute(interactionOrMessage) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;

  let bal = await Balance.findOne({ userId });
  if (!bal) { bal = new Balance({ userId, amount: 500 }); }

  const now = Date.now();
  const last = bal.lastDaily ? new Date(bal.lastDaily).getTime() : 0;
  const daysSince = Math.floor((now - last) / (24*60*60*1000));

  if (last && daysSince === 0) {
    const reply = "You've already claimed your daily reward today.";
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  if (daysSince === 1) {
    bal.dailyStreak = Math.min(5, (bal.dailyStreak || 0) + 1);
  } else {
    bal.dailyStreak = 1;
  }

  const day = bal.dailyStreak;
  let rewardBeli = 0;
  const chestGain = { C:0, B:0, A:0, S:0 };

  if (day === 1) {
    rewardBeli = randInt(10,100);
    chestGain.C += randInt(1,3);
  } else if (day === 2) {
    rewardBeli = randInt(50,300);
    chestGain.C += randInt(1,5);
    if (Math.random() <= 0.8) chestGain.B += randInt(1,2);
  } else if (day === 3) {
    rewardBeli = randInt(300,1000);
    if (Math.random() <= 0.8) chestGain.C += randInt(1,2);
    chestGain.B += randInt(1,3);
    if (Math.random() <= 0.5) chestGain.A += randInt(1,2);
  } else if (day === 4) {
    rewardBeli = randInt(500,2000);
    chestGain.B += randInt(1,5);
    if (Math.random() <= 0.8) chestGain.A += randInt(1,3);
    if (Math.random() <= 0.3) chestGain.S += randInt(1,2);
  } else { // day 5
    rewardBeli = randInt(100,2500);
    if (Math.random() <= 0.8) chestGain.B += randInt(1,3);
    chestGain.A += randInt(1,5);
    if (Math.random() <= 0.5) chestGain.S += randInt(1,3);
  }

  // apply rewards
  bal.amount = (bal.amount || 0) + rewardBeli;
  bal.lastDaily = new Date();
  await bal.save();

  let inv = await Inventory.findOne({ userId });
  if (!inv) inv = new Inventory({ userId, items: {}, chests: { C:0,B:0,A:0,S:0 }, xpBottles:0 });
  inv.chests = inv.chests || { C:0,B:0,A:0,S:0 };
  inv.chests.C = (inv.chests.C || 0) + chestGain.C;
  inv.chests.B = (inv.chests.B || 0) + chestGain.B;
  inv.chests.A = (inv.chests.A || 0) + chestGain.A;
  inv.chests.S = (inv.chests.S || 0) + chestGain.S;
  await inv.save();

  const stars = '★'.repeat(Math.max(0, Math.min(5, day))) + '☆'.repeat(Math.max(0, 5 - day));
  const chestList = [];
  if (chestGain.B) chestList.push(`B x${chestGain.B}`);
  if (chestGain.A) chestList.push(`A x${chestGain.A}`);
  if (chestGain.S) chestList.push(`S x${chestGain.S}`);
  if (chestGain.C && chestList.length === 0) chestList.push(`C x${chestGain.C}`);
  const chestsText = chestList.length ? chestList.join(', ') : 'None';

  const embed = new EmbedBuilder()
    .setTitle('Daily Reward')
    .setColor(0xFFFFFF)
    .setDescription(
      `Beli obtained: ${rewardBeli}¥\n` +
      `Chests obtained: ${chestsText}\n` +
      `daily streak: ${stars}`
    )
    .setFooter({ text: `claimed by ${user.username}`, iconURL: user.displayAvatarURL() });

  if (isInteraction) return interactionOrMessage.reply({ embeds: [embed] });
  return channel.send({ embeds: [embed] });
}
