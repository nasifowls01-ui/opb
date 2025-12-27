import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import Progress from "../models/Progress.js";
import { cards, getCardById, getRankInfo, RANKS } from "../cards.js";

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i-1][j] + 1,
        dp[i][j-1] + 1,
        dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1)
      );
    }
  }
  return dp[a.length][b.length];
}

function findCardFuzzy(query) {
  if (!query) return null;
  query = query.toLowerCase();
  // exact id
  let c = cards.find(x => x.id.toLowerCase() === query);
  if (c) return c;
  // exact name
  c = cards.find(x => x.name.toLowerCase() === query);
  if (c) return c;
  // includes
  const includes = cards.filter(x => x.name.toLowerCase().includes(query) || x.id.toLowerCase().includes(query));
  if (includes.length === 1) return includes[0];
  if (includes.length > 1) return includes[0];
  // best levenshtein on name
  let best = null; let bestScore = Infinity;
  for (const card of cards) {
    const score = levenshtein(card.name.toLowerCase(), query);
    if (score < bestScore) { bestScore = score; best = card; }
  }
  return best;
}

export const data = new SlashCommandBuilder()
  .setName("team")
  .setDescription("View or manage your team")
  .addSubcommand(s => s.setName("view").setDescription("Show your current team"))
  .addSubcommand(s => s.setName("add").setDescription("Add a card to your team").addStringOption(o => o.setName("card").setDescription("Card id or name").setRequired(true)))
  .addSubcommand(s => s.setName("remove").setDescription("Remove a card from your team").addStringOption(o => o.setName("card").setDescription("Card id or name").setRequired(true)))
  .addSubcommand(s => s.setName("autoteam").setDescription("Automatically pick your strongest 3 cards"));

export async function execute(interactionOrMessage, client) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  
  // Guard against missing user
  if (!user || !user.id) {
    console.error("Invalid user object in team command");
    return;
  }
  
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;

  const prog = await Progress.findOne({ userId }) || new Progress({ userId, cards: {}, team: [] });

  let mode = "view";
  let arg = null;
  if (isInteraction) {
    mode = interactionOrMessage.options.getSubcommand();
    arg = interactionOrMessage.options.getString("card");
  } else {
    const parts = interactionOrMessage.content.trim().split(/\s+/);
    // support both `op team add X` and `op teamadd X` and `op autoteam`
    const token = (parts[1] || "").toLowerCase();
    if (token === "team") {
      mode = (parts[2] || "view").toLowerCase();
      arg = parts.slice(3).join(" ") || null;
    } else {
      // token might be 'teamadd' or 'teamremove' or 'autoteam' or 'teamview'
      if (token.startsWith("team") && token.length > 4) {
        mode = token.slice(4);
      } else {
        mode = token || "view";
      }
      arg = parts.slice(2).join(" ") || null;
    }
  }

  if (mode === "add") {
    const card = findCardFuzzy(arg);
    if (!card) return sendReply("Card not found.");
    const cardsMap = prog.cards instanceof Map ? prog.cards : new Map(Object.entries(prog.cards || {}));
    const entry = cardsMap.get(card.id) || { cardId: card.id, count: 0, xp: 0, level: 0 };
    if ((entry.count || 0) <= 0) return sendReply("You don't own that card.");
    // add to team if not present
    prog.team = prog.team || [];
    if (prog.team.includes(card.id)) return sendReply(`${card.name} is already in your team.`);
    if (prog.team.length >= 3) return sendReply("Team is full (3 cards). Remove a card first.");
    prog.team.push(card.id);
    await prog.save();
    return sendReply(`${card.name} added to your team.`);
  }

  if (mode === "remove") {
    const card = findCardFuzzy(arg);
    if (!card) return sendReply("Card not found.");
    prog.team = prog.team || [];
    const idx = prog.team.indexOf(card.id);
    if (idx === -1) return sendReply(`${card.name} is not in your team.`);
    prog.team.splice(idx, 1);
    await prog.save();
    return sendReply(`${card.name} removed from your team.`);
  }

  if (mode === "autoteam") {
    const cardsMap = prog.cards instanceof Map ? prog.cards : new Map(Object.entries(prog.cards || {}));
    const owned = [];
    for (const [cid, entry] of cardsMap.entries()) {
      const card = getCardById(cid);
      if (!card) continue;
      const level = entry.level || 0;
      const score = (card.power || 0) * (1 + level * 0.01);
      owned.push({ card, entry, score });
    }
    if (!owned.length) return sendReply("You have no cards to build a team.");
    owned.sort((a,b) => b.score - a.score);
    prog.team = owned.slice(0,3).map(x => x.card.id);
    await prog.save();
    return sendReply("Auto-team set to your strongest cards.");
  }

  // view
  const teamIds = prog.team || [];
  const lines = teamIds.map((id, i) => {
    const card = getCardById(id);
    const entry = (prog.cards instanceof Map ? prog.cards.get(id) : (prog.cards || {})[id]) || {};
    if (!card) return `#${i+1}: Unknown (${id})`;
    const level = entry.level || 0;
    const power = Math.round((card.power || 0) * (1 + level * 0.01));
    return `#${i+1}: **${card.name}** (${card.rank}) — Power: ${power}`;
  });

  // compute average rank color
  let avgRankVal = 0;
  for (const id of teamIds) {
    const c = getCardById(id);
    const r = c ? getRankInfo(c.rank) : null;
    avgRankVal += (r ? r.value : 1);
  }
  avgRankVal = teamIds.length ? avgRankVal / teamIds.length : 1;
  // find closest rank
  let chosenColor = 0xFFFFFF;
  let bestDiff = Infinity;
  for (const k in RANKS) {
    const r = RANKS[k];
    const d = Math.abs(r.value - avgRankVal);
    if (d < bestDiff) { bestDiff = d; chosenColor = r.color; }
  }

  const embed = new EmbedBuilder()
    .setTitle(`${user.username}'s Team`)
    .setColor(chosenColor)
    .setDescription(lines.length ? lines.join("\n") : "No team set. Use `op team add <card>` or `/team add <card>`.")
    .setFooter({ text: `Requested by ${user.username}`, iconURL: user.displayAvatarURL() });

  if (isInteraction) await interactionOrMessage.reply({ embeds: [embed] }); else await channel.send({ embeds: [embed] });

  async function sendReply(msg) {
    if (isInteraction) return await interactionOrMessage.reply({ content: msg });
    else return await channel.send(msg);
  }
}

export const description = "Manage your 3-card team (view/add/remove/autoteam)";

export const aliases = ["teamadd", "teamremove", "teamview", "autoteam"];
