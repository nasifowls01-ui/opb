import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from "discord.js";
import Progress from "../models/Progress.js";
import { getCardById, cards, getRankInfo } from "../cards.js";

const PAGE_SIZE = 5;

const SORT_MODES = {
  best: "best",
  wtb: "worst",
  lbtw: "level_desc",
  lwtb: "level_asc",
  rank: "rank",
  nto: "newest",
  otn: "oldest",
};

function computeScore(card, entry) {
  const level = entry.level || 0;
  const multiplier = 1 + level * 0.01;
  const power = (card.power || 0) * multiplier;
  // simple score using power primarily, then health
  const health = (card.health || 0) * multiplier;
  return power * 1.0 + health * 0.2;
}

function buildCollectionEmbed(pageItems, page, totalPages, sortLabel) {
  const embed = new EmbedBuilder().setTitle(`Collection — ${sortLabel}`);
  const lines = pageItems.map((it, idx) => {
    const card = it.card;
    const entry = it.entry;
    const level = entry.level || 0;
    const power = Math.round((card.power || 0) * (1 + level * 0.01));
    const attack = `${Math.round(card.attackRange[0] * (1 + level * 0.01))} - ${Math.round(card.attackRange[1] * (1 + level * 0.01))}`;
    const health = Math.round((card.health || 0) * (1 + level * 0.01));
    return `**${idx + 1}. ${card.name}** (Lv ${level}) — Power: ${power} | Attack: ${attack} | HP: ${health}`;
  });
  embed.setDescription(lines.join("\n"));
  embed.setFooter({ text: `Page ${page + 1}/${totalPages}` });
  return embed;
}

function sortCollection(items, mode) {
  switch (mode) {
    case SORT_MODES.best:
      return items.sort((a, b) => computeScore(b.card, b.entry) - computeScore(a.card, a.entry) || (b.entry.level || 0) - (a.entry.level || 0));
    case SORT_MODES.worst:
      return items.sort((a, b) => computeScore(a.card, a.entry) - computeScore(b.card, b.entry));
    case SORT_MODES.lbtw:
      return items.sort((a, b) => (b.entry.level || 0) - (a.entry.level || 0));
    case SORT_MODES.lwtb:
      return items.sort((a, b) => (a.entry.level || 0) - (b.entry.level || 0));
    case SORT_MODES.rank:
      // sort by rank value (higher is better) then by level
      return items.sort((a, b) => (getRankInfo(b.card.rank)?.value || 0) - (getRankInfo(a.card.rank)?.value || 0) || (b.entry.level || 0) - (a.entry.level || 0));
    case SORT_MODES.nto:
      return items.sort((a, b) => (b.entry.acquiredAt || 0) - (a.entry.acquiredAt || 0));
    case SORT_MODES.otn:
      return items.sort((a, b) => (a.entry.acquiredAt || 0) - (b.entry.acquiredAt || 0));
    default:
      return items;
  }
}

export const data = new SlashCommandBuilder()
  .setName("collection")
  .setDescription("View your card collection")
  .addStringOption((opt) =>
    opt.setName("sort").setDescription("Sort mode").setRequired(false).addChoices(
      { name: "Best to Worst", value: "best" },
      { name: "Worst to Best", value: "wtb" },
      { name: "Level High to Low", value: "lbtw" },
      { name: "Level Low to High", value: "lwtb" },
      { name: "Newest to Oldest", value: "nto" },
      { name: "Oldest to Newest", value: "otn" }
    )
  );

export async function execute(interactionOrMessage, client) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;

  let sortKey = SORT_MODES.best;
  if (isInteraction) {
    const val = interactionOrMessage.options.getString("sort");
    if (val && SORT_MODES[val]) sortKey = SORT_MODES[val];
    else if (val) {
      // map short value strings
      if (val === "wtb") sortKey = SORT_MODES.wtb;
      else if (val === "lbtw") sortKey = SORT_MODES.lbtw;
      else if (val === "lwtb") sortKey = SORT_MODES.lwtb;
      else if (val === "nto") sortKey = SORT_MODES.nto;
      else if (val === "otn") sortKey = SORT_MODES.otn;
    }
  } else {
    const parts = interactionOrMessage.content.trim().split(/\s+/);
    // remove prefix and command
    parts.splice(0, 2);
    const arg = parts[0]?.toLowerCase();
    if (!arg) sortKey = SORT_MODES.best;
    else {
      if (arg === "wtb") sortKey = SORT_MODES.wtb;
      else if (arg === "lbtw") sortKey = SORT_MODES.lbtw;
      else if (arg === "lwtb") sortKey = SORT_MODES.lwtb;
      else if (arg === "nto") sortKey = SORT_MODES.nto;
      else if (arg === "otn") sortKey = SORT_MODES.otn;
      else sortKey = SORT_MODES.best;
    }
  }

  // fetch progress
  const progDoc = await Progress.findOne({ userId });
  if (!progDoc || !progDoc.cards || Object.keys(progDoc.cards || {}).length === 0) {
    const reply = "You don't own any cards yet.";
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
    else await channel.send(reply);
    return;
  }

  const cardsMap = progDoc.cards instanceof Map ? progDoc.cards : new Map(Object.entries(progDoc.cards || {}));
  const items = [];
  for (const [cardId, entry] of cardsMap.entries()) {
    const card = getCardById(cardId);
    if (!card) continue;
    items.push({ card, entry });
  }

  // sort
  sortCollection(items, sortKey);

  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const page = 0;
  const pageItems = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const embed = buildCollectionEmbed(pageItems, page, totalPages, Object.keys(SORT_MODES).find(k=>SORT_MODES[k]===sortKey) || "custom");

  const prevId = `collection_prev:${userId}:${sortKey}:${page}`;
  const nextId = `collection_next:${userId}:${sortKey}:${page}`;
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(prevId).setLabel("Previous").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(nextId).setLabel("Next").setStyle(ButtonStyle.Secondary)
  );

  // add a select menu for sort options (interaction only)
  const sortMenu = new StringSelectMenuBuilder()
    .setCustomId(`collection_sort:${userId}`)
    .setPlaceholder('Sort collection')
    .addOptions([
      { label: 'Best to Worst', value: 'best' },
      { label: 'Worst to Best', value: 'wtb' },
      { label: 'Level High → Low', value: 'lbtw' },
      { label: 'Level Low → High', value: 'lwtb' },
      { label: 'Rank High → Low', value: 'rank' },
      { label: 'Newest → Oldest', value: 'nto' },
      { label: 'Oldest → Newest', value: 'otn' }
    ]);
  const sortRow = new ActionRowBuilder().addComponents(sortMenu);

  if (isInteraction) await interactionOrMessage.reply({ embeds: [embed], components: [sortRow, row] });
  else await channel.send({ embeds: [embed], components: [row] });
}
