import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import Balance from "../models/Balance.js";
import Progress from "../models/Progress.js";
import Pull from "../models/Pull.js";
import Inventory from "../models/Inventory.js";
import { cards } from "../cards.js";

export const data = new SlashCommandBuilder()
  .setName("user")
  .setDescription("Show a user's profile")
  .addUserOption(o => o.setName("target").setDescription("User to inspect (optional)"));
export const category = "Info";
export const description = "Show user's profile and statistics";

function progressBar(curr, max, size = 20){
  const pct = Math.max(0, Math.min(1, (curr / max) || 0));
  const filled = Math.round(pct * size);
  const empty = size - filled;
  const filledChar = '█';
  const emptyChar = '░';
  return filledChar.repeat(filled) + emptyChar.repeat(empty) + ` ${Math.round(pct*100)}%`;
}

function fmtNumber(n){ return (n||0).toLocaleString(); }

export async function execute(interactionOrMessage, client){
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? (interactionOrMessage.options.getUser("target") || interactionOrMessage.user) : (function(){
    const parts = interactionOrMessage.content.trim().split(/\s+/);
    // message form: `user` or `user @mention` or `op user @mention` will call this file in the prefix handler
    if (parts[1]){
      const m = parts[1].replace(/[^0-9]/g, "");
      if (m) return { id: m, username: parts[1] };
    }
    return interactionOrMessage.author;
  })();
  const userId = user.id;

  // load models
  const [bal, prog, pullDoc, inv] = await Promise.all([
    Balance.findOne({ userId }),
    Progress.findOne({ userId }),
    Pull.findOne({ userId }),
    Inventory.findOne({ userId })
  ]);

  const level = (bal && (bal.level || 0)) || 0;
  const xp = (bal && (bal.xp || 0)) || 0;
  const xpToNext = 100 - (xp % 100 || 0);
  const bar = progressBar(xp % 100, 100, 20);

  const wealth = (bal && bal.amount) || 0;
  const higher = await Balance.countDocuments({ amount: { $gt: wealth } });
  const globalRank = higher + 1;

  // team and average power
  const teamArr = (prog && Array.isArray(prog.team) ? prog.team : []);
  let avgPower = 0;
  let teamNames = [];
  if (teamArr.length > 0){
    let sum = 0; let found = 0;
    for (const cid of teamArr){
      const c = cards.find(x => x.id === cid);
      if (c){
        // Calculate power with level boost: power * (1 + level * 0.01)
        const hasMap = prog && prog.cards && typeof prog.cards.get === 'function';
        const cardProgress = hasMap ? (prog.cards.get(cid) || { level: 1 }) : (prog.cards && prog.cards[cid] || { level: 1 });
        const levelBoost = (cardProgress.level || 1) * 0.01;
        const boostedPower = Math.round(c.power * (1 + levelBoost));
        sum += boostedPower;
        found++;
        teamNames.push(`${c.name} (${c.rank})`);
      }
    }
    avgPower = found ? Math.round(sum / found) : 0;
  }

  // statistics
  const totalPulls = (pullDoc && (pullDoc.totalPulls || 0)) || 0;
  const cardMap = prog && prog.cards ? (prog.cards instanceof Map ? Object.fromEntries(prog.cards) : prog.cards) : {};
  const uniqueCards = Object.keys(cardMap || {}).length;
  let totalCardsCount = 0;
  for (const k of Object.keys(cardMap || {})){
    const e = cardMap[k] || {};
    totalCardsCount += (e.count || 0);
  }

  // build embed (white)
  const embed = new EmbedBuilder()
    .setColor(0xFFFFFF)
    .setTitle(`${user.username || (user.tag || userId)}`)
    .setThumbnail(user.displayAvatarURL ? user.displayAvatarURL() : null)
    .setDescription(
      `Level ${level} • XP to next: ${xpToNext}\n${bar}\n\n` +
      `**Wealth:** ${fmtNumber(wealth)}¥\n` +
      `**Global ranking:** #${globalRank}\n\n` +
      `**statistics:**\n` +
      `total pulls: ${fmtNumber(totalPulls)}\n` +
      `Unique Cards: ${uniqueCards}/${cards.length}`
    )
    .setFooter({ text: `Requested by ${ (interactionOrMessage.user || interactionOrMessage.author).username }`, iconURL: (interactionOrMessage.user || interactionOrMessage.author).displayAvatarURL?.() });

  // (How to level up section intentionally omitted per request)

  if (isInteraction) return interactionOrMessage.reply({ embeds: [embed] });
  return interactionOrMessage.channel.send({ embeds: [embed] });
}
