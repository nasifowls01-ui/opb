import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import Inventory from '../models/Inventory.js';
import Balance from '../models/Balance.js';
import Quest from '../models/Quest.js';
import { getChestRewards, RANKS } from '../lib/chests.js';

export const data = new SlashCommandBuilder()
  .setName('chest')
  .setDescription('Open chests to get rewards')
  .addStringOption(option =>
    option.setName('rank')
      .setDescription('The rank of chest to open (C, B, A, or S)')
      .setRequired(true)
      .addChoices(
        { name: 'C Rank', value: 'C' },
        { name: 'B Rank', value: 'B' },
        { name: 'A Rank', value: 'A' },
        { name: 'S Rank', value: 'S' }
      ))
  .addIntegerOption(option =>
    option.setName('amount')
      .setDescription('Number of chests to open')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(10));

export async function execute(interactionOrMessage, client) {
  const isInteraction = typeof interactionOrMessage.isCommand === 'function' || typeof interactionOrMessage.isChatInputCommand === 'function';
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;

  let rank;
  let amount;
  if (isInteraction) {
    rank = interactionOrMessage.options.getString('rank');
    amount = interactionOrMessage.options.getInteger('amount');
  } else {
    const parts = interactionOrMessage.content.trim().split(/\s+/);
    // expected: op chest <rank> <amount>
    rank = (parts[2] || '').toUpperCase();
    amount = parts[3] ? parseInt(parts[3], 10) : 1;
    if (!rank || !RANKS.includes(rank) || !amount || amount < 1 || amount > 10) {
      await channel.send('Usage: `op chest <C|B|A|S> <amount (1-10)>`');
      return;
    }
  }

  const userId = user.id;

  let inventory = await Inventory.findOne({ userId });
  if (!inventory) inventory = new Inventory({ userId });

  if (!inventory.chests[rank] || inventory.chests[rank] < amount) {
    const replyText = `You don't have enough ${rank} rank chests! You have: ${inventory.chests[rank] || 0}`;
    if (isInteraction) return interactionOrMessage.reply(replyText);
    return channel.send(replyText);
  }

  // helper to detect Map vs plain object
  const hasMap = inventory.items && typeof inventory.items.get === 'function';

  let totalYen = 0;
  let totalXpScrolls = 0;
  let totalXpBooks = 0;
  let totalBattleTokens = 0;
  let totalResetTokens = 0;
  const healingTotals = {};
  const materialTotals = {};
  const legendaryWon = [];
  const legendaryDuplicates = [];

  const putItem = (key, qty) => {
    if (!qty) return;
    if (hasMap) {
      const prev = inventory.items.get(key) || 0;
      inventory.items.set(key, prev + qty);
    } else {
      inventory.items = inventory.items || {};
      inventory.items[key] = (inventory.items[key] || 0) + qty;
    }
  };

  for (let i = 0; i < amount; i++) {
    const rewards = getChestRewards(rank, inventory.items);
    totalYen += rewards.yen || 0;
    totalXpScrolls += rewards.xpScrolls || 0;
    totalXpBooks += rewards.xpBooks || 0;
    totalBattleTokens += rewards.battleTokens || 0;
    totalResetTokens += rewards.resetTokens || 0;

    for (const [h, c] of Object.entries(rewards.healing || {})) {
      healingTotals[h] = (healingTotals[h] || 0) + c;
    }
    for (const [m, c] of Object.entries(rewards.materials || {})) {
      materialTotals[m] = (materialTotals[m] || 0) + c;
    }

    for (const leg of rewards.legendaries || []) {
      const owned = hasMap ? (inventory.items.get(leg) || 0) : (inventory.items && inventory.items[leg] || 0);
      if (owned) {
        totalResetTokens += 1; // fallback for duplicate legendary
        legendaryDuplicates.push(leg);
      } else {
        legendaryWon.push(leg);
      }
    }
  }

  // consume chests
  inventory.chests[rank] -= amount;

  // apply xp scrolls/books
  inventory.xpScrolls = (inventory.xpScrolls || 0) + totalXpScrolls;
  inventory.xpBooks = (inventory.xpBooks || 0) + totalXpBooks;

  // apply items (reset tokens go to Balance.resetTokens, not inventory)
  // XP books are stored in inventory.xpBooks (avoid duplicating as 'xp_book')
  putItem('Battle Token', totalBattleTokens);
  for (const [k, v] of Object.entries(healingTotals)) putItem(k, v);
  for (const [k, v] of Object.entries(materialTotals)) putItem(k, v);
  for (const leg of legendaryWon) putItem(leg, 1);

  // convert Map-like inventory.items into a plain object so Mongoose reliably persists changes
  if (inventory.items && typeof inventory.items.get === 'function') {
    const asObj = {};
    for (const k of inventory.items.keys()) {
      asObj[k] = inventory.items.get(k) || 0;
    }
    inventory.items = asObj;
  }
  // save inventory
  await inventory.save();

  // apply currency and reset tokens to balance
  let balance = await Balance.findOne({ userId });
  if (!balance) balance = new Balance({ userId });
  balance.amount = (balance.amount || 0) + totalYen;
  balance.resetTokens = (balance.resetTokens || 0) + totalResetTokens;
  await balance.save();

  // Record quest progress for opening chests
  try {
    const [dailyQuests, weeklyQuests] = await Promise.all([
      Quest.getCurrentQuests('daily'),
      Quest.getCurrentQuests('weekly')
    ]);
    await Promise.all([
      dailyQuests.recordAction(userId, 'chest', amount),
      weeklyQuests.recordAction(userId, 'chest', amount)
    ]);
  } catch (e) {
    console.error('Failed to record chest quest progress:', e);
  }

  // build embed reply without emojis, per requested format
  const lines = [];
  lines.push(`beli **${totalYen}**`);
  if (totalXpScrolls) lines.push(`XP scroll **${totalXpScrolls}**`);
  if (totalXpBooks) lines.push(`XP book **${totalXpBooks}**`);
  if (totalBattleTokens) lines.push(`Battle Token **${totalBattleTokens}**`);
  if (totalResetTokens) lines.push(`reset token *x${totalResetTokens}*`);

  for (const [k, v] of Object.entries(healingTotals)) lines.push(`${k} *x${v}*`);
  for (const [k, v] of Object.entries(materialTotals)) lines.push(`${k} *x${v}*`);
  for (const l of legendaryWon) lines.push(`${l} *x1*`);

  if (legendaryDuplicates.length) {
    lines.push(...legendaryDuplicates.map(l => `${l} (duplicate converted to reset token)`));
  }

  lines.push(`\nRemaining ${rank} rank chests: ${inventory.chests[rank]}`);

  const embed = new EmbedBuilder()
    .setTitle('Rewards obtained')
    .setColor(0xFFFFFF)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${amount} ${rank} tier chest${amount>1? 's' : ''} was opened by "${user.username}"` });

  if (isInteraction) return interactionOrMessage.reply({ embeds: [embed] });
  return channel.send({ embeds: [embed] });
}