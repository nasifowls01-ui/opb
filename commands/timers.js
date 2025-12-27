import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import Balance from "../models/Balance.js";
import Pull from "../models/Pull.js";
import Quest from "../models/Quest.js";
import Duel from "../models/Duel.js";

export const data = new SlashCommandBuilder()
  .setName("timers")
  .setDescription("Show your OP timers: quests, pulls, missions, gambling, daily");

export async function execute(interactionOrMessage) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;

  const now = Date.now();
  const lines = [];

  // Daily quests and Weekly quests (expiresAt)
  try {
    const daily = await Quest.getCurrentQuests("daily");
    const weekly = await Quest.getCurrentQuests("weekly");
    if (daily && daily.expiresAt) {
      const ms = daily.expiresAt.getTime() - now;
      if (ms > 0) lines.push(`• Daily quests reset in: ${formatMs(ms)}`);
      else lines.push(`• Daily quests: resetting soon`);
    }
    if (weekly && weekly.expiresAt) {
      const ms = weekly.expiresAt.getTime() - now;
      if (ms > 0) lines.push(`• Weekly quests reset in: ${formatMs(ms)}`);
      else lines.push(`• Weekly quests: resetting soon`);
    }
  } catch (e) {
    console.error("Failed to fetch quests for timers:", e);
  }

  // Pull reset (8h window)
  try {
    const WINDOW_MS = 8 * 60 * 60 * 1000;
    const pull = await Pull.findOne({ userId });
    if (pull) {
      const nextReset = (pull.window + 1) * WINDOW_MS;
      const ms = nextReset - now;
      if (ms > 0) lines.push(`• Pulls reset in: ${formatMs(ms)}`);
      else lines.push(`• Pulls: resetting soon`);
    } else {
      lines.push(`• Pulls: you have full pulls (no active window)`);
    }
  } catch (e) {}

  // Missions, Gambling, Daily, Duel XP (per-user fields in Balance)
  try {
    let bal = await Balance.findOne({ userId });
    if (!bal) bal = new Balance({ userId });
    const duel = await Duel.findOne({ userId });

    // Missions: lastMission + 24h
    if (bal.lastMission) {
      const next = new Date(bal.lastMission).getTime() + (24*60*60*1000);
      const ms = next - now;
      if (ms > 0) lines.push(`• Mission available in: ${formatMs(ms)}`);
      else lines.push(`• Mission: available now`);
    } else {
      lines.push(`• Mission: available now`);
    }

    // Gambling: daily window
    const dayMs = 24*60*60*1000;
    const win = bal.gambleWindow || Math.floor(now / dayMs);
    const nextGambleReset = (win + 1) * dayMs;
    const msG = nextGambleReset - now;
    lines.push(`• Gambling resets in: ${formatMs(msG)} • Gambles today: ${bal.gamblesToday || 0}/10`);

    // Duel XP tracking (max 100 per day)
    if (duel) {
      const duelWin = duel.xpWindow || Math.floor(now / dayMs);
      if (duelWin !== Math.floor(now / dayMs)) {
        lines.push(`• Duel XP: 0/100 (resets soon)`);
      } else {
        lines.push(`• Duel XP: ${duel.xpToday || 0}/100`);
      }
    } else {
      lines.push(`• Duel XP: 0/100`);
    }

    // Daily command availability
    if (bal.lastDaily) {
      const next = new Date(bal.lastDaily).getTime() + (24*60*60*1000);
      const ms = next - now;
      if (ms > 0) lines.push(`• Daily available in: ${formatMs(ms)} • Streak: ${bal.dailyStreak || 0}/5`);
      else lines.push(`• Daily: available now`);
    } else {
      lines.push(`• Daily: available now`);
    }
  } catch (e) {
    console.error("Failed to fetch balance for timers:", e);
  }

  const header = `Here are all the important bot timers!\n\n`;
  const text = header +
    `**daily quests:** ${lines.find(l => l.startsWith('• Daily quests')) ? '\n' + lines.filter(l => l.startsWith('• Daily quests')).join('\n') : '\nNo data'}\n\n` +
    `**weekly quests:** ${lines.find(l => l.startsWith('• Weekly quests')) ? '\n' + lines.filter(l => l.startsWith('• Weekly quests')).join('\n') : '\nNo data'}\n\n` +
    `**pulls:** ${lines.find(l => l.startsWith('• Pulls')) ? '\n' + lines.filter(l => l.startsWith('• Pulls')).join('\n') : '\nNo data'}\n\n` +
    `**mission:** ${lines.find(l => l.includes('Mission')) ? '\n' + lines.filter(l => l.includes('Mission')).join('\n') : '\nNo data'}\n\n` +
    `**gambling:** ${lines.find(l => l.includes('Gambling')) ? '\n' + lines.filter(l => l.includes('Gambling')).join('\n') : '\nNo data'}\n\n` +
    `**duel xp:** ${lines.find(l => l.includes('Duel XP')) ? '\n' + lines.filter(l => l.includes('Duel XP')).join('\n') : '\nNo data'}\n\n` +
    `**daily rewards:** ${lines.find(l => l.includes('Daily available') || l.includes('Daily:')) ? '\n' + lines.filter(l => l.includes('Daily available') || l.includes('Daily:')).join('\n') : '\nNo data'}\n`;

  if (isInteraction) return interactionOrMessage.reply({ content: text });
  return channel.send({ content: text });
}

function formatMs(ms) {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec) parts.push(`${sec}s`);
  return parts.join(" ");
}
