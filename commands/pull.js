import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getRandomCardByProbability, getRankInfo, getCardById } from "../cards.js";
import Pull from "../models/Pull.js";
import Balance from "../models/Balance.js";
import Progress from "../models/Progress.js";
const WINDOW_MS = 8 * 60 * 60 * 1000; // 8 hours
const MAX_PULLS = 7;

const RANK_XP = {
  C: 20,
  B: 50,
  A: 75,
  S: 100,
};

// default probabilities (percentages)
const PULL_PROBABILITIES = { C: 60, B: 30, A: 8, S: 1, ITEM: 1 };

// MongoDB (mongoose) is used for persistence via models/Pull.js and models/Progress.js

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

export const data = new SlashCommandBuilder().setName("pull").setDescription("Pull a card (7 pulls per 8h reset)");

export async function execute(interactionOrMessage, client) {
  // determine if this is an interaction or a message
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  
  // Guard against missing user
  if (!user || !user.id) {
    console.error("Invalid user object in pull command");
    return;
  }
  
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;

  const currentWindow = Math.floor(Date.now() / WINDOW_MS);

  // load or initialize Pull document for this user
  let pullDoc = await Pull.findOne({ userId });
  if (!pullDoc || pullDoc.window !== currentWindow) {
    // start a new window
    pullDoc = await Pull.findOneAndUpdate(
      { userId },
      { userId, window: currentWindow, used: 0 },
      { upsert: true, new: true }
    );
  }

  if (pullDoc.used >= MAX_PULLS) {
    const nextReset = (pullDoc.window + 1) * WINDOW_MS;
    const timeLeft = nextReset - Date.now();
    const reply = `You've used all ${MAX_PULLS} pulls. Next reset in \`${formatTime(timeLeft)}\`.`;
    if (isInteraction) {
      await interactionOrMessage.reply({ content: reply, ephemeral: true });
    } else {
      await channel.send(reply);
    }
    return;
  }

  // consume one pull (respecting existing window) and increment total pulls for pity
  if (pullDoc.window !== currentWindow) {
    pullDoc.window = currentWindow;
    pullDoc.used = 1;
    pullDoc.totalPulls = (pullDoc.totalPulls || 0) + 1;
  } else {
    pullDoc.used += 1;
    pullDoc.totalPulls = (pullDoc.totalPulls || 0) + 1;
  }
  await pullDoc.save();

  // perform pull (probability-driven) with 100-pull pity and level sampling
  // determine current position in 100-pull pity cycle (1..100)
  const total = pullDoc.totalPulls || 0;
  const cyclePos = (total % 100) === 0 ? 100 : (total % 100);

  // guarantee S card on every 100th pull
  let pulled = null;
  if (cyclePos === 100) {
    const { cards } = await import("../cards.js");
    const sPool = cards.filter((c) => !c.isUpgrade && c.rank && String(c.rank).toUpperCase() === "S");
    if (sPool.length > 0) pulled = sPool[Math.floor(Math.random() * sPool.length)];
  }
  if (!pulled) pulled = getRandomCardByProbability(PULL_PROBABILITIES);

  // ensure user's progress document
  let progDoc = await Progress.findOne({ userId });
  if (!progDoc) {
    progDoc = new Progress({ userId, cards: {} });
  }

  // progDoc.cards may be a Mongoose Map or a plain object; normalize to a Map
  let userCardsMap;
  if (progDoc.cards instanceof Map) {
    userCardsMap = progDoc.cards;
  } else {
    // convert plain object to Map
    userCardsMap = new Map(Object.entries(progDoc.cards || {}));
  }

  let description = "";
  // footer will show pity cycle progress instead of per-window pulls
  const footer = `Pity: ${cyclePos}/100`;

  // If user already owns an upgraded version of this card, convert the pull
  // to that highest owned upgrade in the chain.
  function getUpgradeChainSync(card) {
    const chain = [card];
    const visited = new Set([card.id]);
    let current = card;
    while (current && current.evolutions && current.evolutions.length > 0) {
      const nextCardId = current.evolutions[0];
      const nextCard = getCardById(nextCardId);
      if (!nextCard || visited.has(nextCard.id)) break;
      visited.add(nextCard.id);
      chain.push(nextCard);
      current = nextCard;
    }
    return chain;
  }

  const chain = getUpgradeChainSync(pulled);
  let ownedUpgrade = null;
  for (let i = 1; i < chain.length; i++) {
    const cardInChain = chain[i];
    const entry = userCardsMap.get(cardInChain.id);
    if (entry && (entry.count || 0) > 0) ownedUpgrade = cardInChain;
  }
  if (ownedUpgrade) pulled = ownedUpgrade;

  // check duplicate -> convert to XP
  // read existing entry from Map
  const existing = userCardsMap.get(pulled.id);
  const wasDuplicate = !!existing && (existing.count || 0) > 0;

  // sample a level between 1 and cyclePos (rarer for higher levels)
  function sampleLevel(maxLevel) {
    const lambda = 0.1; // controls rarity curve; ~5% chance to be >30 at max
    // weights for levels 1..maxLevel
    const weights = new Array(maxLevel);
    let sum = 0;
    for (let k = 1; k <= maxLevel; k++) {
      const w = Math.exp(-lambda * (k - 1));
      weights[k - 1] = w;
      sum += w;
    }
    const r = Math.random() * sum;
    let acc = 0;
    for (let i = 0; i < weights.length; i++) {
      acc += weights[i];
      if (r <= acc) return i + 1;
    }
    return maxLevel;
  }

  const pulledLevel = sampleLevel(cyclePos);

  if (existing && existing.count > 0) {
    const xpGain = RANK_XP[pulled.rank.toUpperCase()] || 0;
    existing.xp = (existing.xp || 0) + xpGain;
    description = `Converted to **${xpGain} XP**.`;

    // Do NOT overwrite existing.level with the pulled duplicate's sampled level.
    // Only level up via accumulated XP.
    let leveled = false;
    while ((existing.xp || 0) >= 100) {
      existing.xp -= 100;
      existing.level = (existing.level || 0) + 1;
      leveled = true;
    }
    if (leveled) description += ` Your card leveled up to level ${existing.level}!`;
    userCardsMap.set(pulled.id, existing);
  } else {
    const newEntry = { count: 1, xp: 0, level: Math.min(100, pulledLevel), acquiredAt: Date.now() };
    userCardsMap.set(pulled.id, newEntry);
    // move the "added to your collection" text to the title later when building the embed
    description = ``;
  }

  // write back to progress doc (keep as Map for Mongoose tracking)
  progDoc.cards = userCardsMap;
  progDoc.markModified('cards');
  await progDoc.save();

  // Update quest progress
  const Quest = (await import("../models/Quest.js")).default;
  const [dailyQuests, weeklyQuests] = await Promise.all([
    Quest.getCurrentQuests("daily"),
    Quest.getCurrentQuests("weekly")
  ]);

  // Ensure quests are generated before recording (if command hasn't been used yet)
  if (!dailyQuests.quests.length) {
    const { generateQuests } = await import("../lib/quests.js");
    dailyQuests.quests = generateQuests("daily");
    await dailyQuests.save();
  }
  if (!weeklyQuests.quests.length) {
    const { generateQuests } = await import("../lib/quests.js");
    weeklyQuests.quests = generateQuests("weekly");
    await weeklyQuests.save();
  }

  await Promise.all([
    dailyQuests.recordAction(userId, "pull", 1),
    weeklyQuests.recordAction(userId, "pull", 1)
  ]);

  // award 1xp to user for pulling
  try {
    let balDoc = await Balance.findOne({ userId });
    if (!balDoc) { balDoc = new Balance({ userId, amount: 500, xp: 0, level: 0 }); }
    balDoc.xp = (balDoc.xp || 0) + 1;
    while ((balDoc.xp || 0) >= 100) {
      balDoc.xp -= 100;
      balDoc.level = (balDoc.level || 0) + 1;
    }
    await balDoc.save();
  } catch (e) { /* non-fatal */ }

  // Show base stats (level 1) for card pull embed
  const effectivePower = pulled.power;
  const effectiveAttackMin = pulled.attackRange[0];
  const effectiveAttackMax = pulled.attackRange[1];
  const effectiveHealth = pulled.health || 0;

  // build embed similar to the provided image layout
  const rankInfo = getRankInfo(pulled.rank);

  // build compact 2x2 embed layout and include pulled level
  const displayEntry = userCardsMap.get(pulled.id) || {};
  const displayLevel = displayEntry.level || 0;
  // If this was a duplicate pull, do not show the duplicate's level — show XP conversion only
  let statsText;
  if (wasDuplicate) {
    statsText = `**Power:** ${effectivePower}
**Attack:** ${effectiveAttackMin} - ${effectiveAttackMax}
**Health:** ${effectiveHealth}
**Effect:** ${pulled.ability ? pulled.ability : "None"}`;
  } else {
    statsText = `**Level:** ${displayLevel}
**Power:** ${effectivePower}
**Attack:** ${effectiveAttackMin} - ${effectiveAttackMax}
**Health:** ${effectiveHealth}
**Effect:** ${pulled.ability ? pulled.ability : "None"}`;
  }

  // if this was a new acquisition, show the card's `title` as normal text in the description
  const isNew = description === "" && (userCardsMap.get(pulled.id) || {}).acquiredAt;
  const entryForTitle = userCardsMap.get(pulled.id) || {};
  const subtitle = isNew && pulled.title ? `${pulled.title}` : "";
  // include card type (Attacking/Support) in footer next to pity
  const typeLabel = pulled.type === "Attack" ? "Attacking Card" : (pulled.type || "-");
  const footerText = `${footer} • ${typeLabel}`;

  const descPrefix = subtitle ? `${subtitle}\n\n` : "";
  const embed = new EmbedBuilder()
    .setTitle(pulled.name)
    .setColor(rankInfo?.color || 0x1abc9c)
    .setDescription(`${descPrefix}${description}\n\n${statsText}`)
    .setFooter({ text: footerText, iconURL: user.displayAvatarURL() });

  // leave space for rank icon and card image — if you paste URLs into the card definitions (cards.js)
  // rank icon comes from rank info map
  if (rankInfo?.icon) embed.setThumbnail(rankInfo.icon);
  if (pulled.image) embed.setImage(pulled.image);

  if (isInteraction) {
    await interactionOrMessage.reply({ embeds: [embed] });
  } else {
    await channel.send({ embeds: [embed] });
  }
}
