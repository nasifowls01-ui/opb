import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import Balance from "../models/Balance.js";
import Duel from "../models/Duel.js";
import Progress from "../models/Progress.js";
import { getCardById } from "../cards.js";
import Quest from "../models/Quest.js";

const DUEL_SESSIONS = global.__DUEL_SESSIONS ||= new Map();

export const data = new SlashCommandBuilder()
  .setName("duel")
  .setDescription("Challenge another user to a duel")
  .addUserOption(opt => opt.setName("opponent").setDescription("User to duel").setRequired(true));

export const category = "Combat";
export const description = "Challenge another user to a duel";

function dayWindow() { return Math.floor(Date.now() / (24*60*60*1000)); }

function makeEmbed(title, desc) {
  return new EmbedBuilder().setTitle(title).setDescription(desc).setColor(0xFFFFFF);
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function execute(interactionOrMessage) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;
  
  let opponent;
  if (isInteraction) {
    opponent = interactionOrMessage.options.getUser("opponent");
  } else {
    // Parse prefix: "op duel @user"
    const mentioned = interactionOrMessage.mentions.users.first();
    if (!mentioned) return channel.send("Please mention a user to duel.");
    opponent = mentioned;
  }

  if (opponent.id === userId) return channel.send("You can't duel yourself!");
  if (opponent.bot) return channel.send("You can't duel bots!");

  // Get both users' teams and check they have them
  const [p1Progress, p2Progress] = await Promise.all([
    Progress.findOne({ userId }),
    Progress.findOne({ userId: opponent.id })
  ]);

  if (!p1Progress || !p1Progress.team || p1Progress.team.length === 0) {
    const reply = "You need to have a team to duel. Use `/team add` to build your team.";
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  if (!p2Progress || !p2Progress.team || p2Progress.team.length === 0) {
    const reply = `${opponent.username} doesn't have a team set up yet.`;
    if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
    return channel.send(reply);
  }

  // Check duel limits (3 per day with same person)
  const [p1Duel, p2Duel] = await Promise.all([
    Duel.findOne({ userId }),
    Duel.findOne({ userId: opponent.id })
  ]);

  const win = dayWindow();
  if (p1Duel) {
    if (p1Duel.duelWindow !== win) {
      p1Duel.duelWindow = win;
      p1Duel.duelOpponents = new Map();
    }
    const duelCount = p1Duel.duelOpponents.get(opponent.id) || 0;
    if (duelCount >= 3) {
      const reply = `You've already dueled ${opponent.username} 3 times today!`;
      if (isInteraction) return interactionOrMessage.reply({ content: reply, ephemeral: true });
      return channel.send(reply);
    }
  }

  // Send challenge embed to opponent
  const embed = makeEmbed(
    "Duel Challenge",
    `${user} is challenging you to a duel!\n\nAccept the challenge to begin battle.`
  );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`duel_accept:${userId}`).setLabel("Accept").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`duel_decline:${userId}`).setLabel("Decline").setStyle(ButtonStyle.Danger)
  );

  const msg = await channel.send({ content: opponent.toString(), embeds: [embed], components: [row] });

  // Setup duel acceptance collector (30s timeout)
  const filter = (i) => i.user.id === opponent.id;
  const collector = msg.createMessageComponentCollector({ filter, time: 30000 });

  collector.on("collect", async i => {
    await i.deferUpdate();

    if (i.customId.startsWith("duel_decline")) {
      try {
        await msg.edit({ embeds: [makeEmbed("❌ Duel Declined", `${opponent.username} declined the challenge.`)], components: [] });
      } catch (e) {}
      return;
    }

    if (i.customId.startsWith("duel_accept")) {
      // Start the duel
      try {
        await msg.edit({ embeds: [makeEmbed("⚔️ Duel Started", "Loading teams...")], components: [] });
      } catch (e) {}

      // Initialize duel session
      const sessionId = `${userId}_${opponent.id}_${Date.now()}`;
      
      // Get card details and health
      const p1Cards = p1Progress.team.map(cardId => {
        const card = getCardById(cardId);
        const hasMap = p1Progress.cards && typeof p1Progress.cards.get === 'function';
        const progress = hasMap ? (p1Progress.cards.get(cardId) || { level: 0, xp: 0 }) : (p1Progress.cards[cardId] || { level: 0, xp: 0 });
        const level = progress.level || 0;
        const mult = 1 + (level * 0.01);
        const health = Math.round((card.health || 0) * mult);
        const attackMin = Math.round((card.attackRange?.[0] || 0) * mult);
        const attackMax = Math.round((card.attackRange?.[1] || 0) * mult);
        const special = card.specialAttack ? { ...card.specialAttack, range: [(card.specialAttack.range[0] || 0) * mult, (card.specialAttack.range[1] || 0) * mult] } : null;
        const power = Math.round((card.power || 0) * mult);
        return { cardId, card, scaled: { attackRange: [attackMin, attackMax], specialAttack: special, power }, health, maxHealth: health, level };
      });

      const p2Cards = p2Progress.team.map(cardId => {
        const card = getCardById(cardId);
        const hasMap = p2Progress.cards && typeof p2Progress.cards.get === 'function';
        const progress = hasMap ? (p2Progress.cards.get(cardId) || { level: 0, xp: 0 }) : (p2Progress.cards[cardId] || { level: 0, xp: 0 });
        const level = progress.level || 0;
        const mult = 1 + (level * 0.01);
        const health = Math.round((card.health || 0) * mult);
        const attackMin = Math.round((card.attackRange?.[0] || 0) * mult);
        const attackMax = Math.round((card.attackRange?.[1] || 0) * mult);
        const special = card.specialAttack ? { ...card.specialAttack, range: [Math.round((card.specialAttack.range[0] || 0) * mult), Math.round((card.specialAttack.range[1] || 0) * mult)] } : null;
        const power = Math.round((card.power || 0) * mult);
        return { cardId, card, scaled: { attackRange: [attackMin, attackMax], specialAttack: special, power }, health, maxHealth: health, level };
      });

      // Determine who goes first (highest power)
      const p1Power = Math.max(...p1Cards.map(c => c.scaled.power || 0));
      const p2Power = Math.max(...p2Cards.map(c => c.scaled.power || 0));
      const firstPlayer = p1Power >= p2Power ? userId : opponent.id;

      DUEL_SESSIONS.set(sessionId, {
        p1: { userId, user, cards: p1Cards, lifeIndex: 0 },
        p2: { userId: opponent.id, user: opponent, cards: p2Cards, lifeIndex: 0 },
        currentTurn: firstPlayer,
        sessionId,
        channelId: channel.id,
        msgId: msg.id,
      });

      // Start turn
      await startDuelTurn(sessionId, channel);
    }
  });

  collector.on("end", async (collected) => {
    if (collected.size === 0) {
      try {
        await msg.edit({ embeds: [makeEmbed("Duel Expired", "Challenge expired after 30 seconds.")], components: [] });
      } catch (e) {}
    }
  });

  if (isInteraction) {
    await interactionOrMessage.reply({ content: `Duel challenge sent to ${opponent}!`, ephemeral: true });
  }
}

async function startDuelTurn(sessionId, channel) {
  const session = DUEL_SESSIONS.get(sessionId);
  if (!session) return;

  const currentIsP1 = session.currentTurn === session.p1.userId;
  const attacker = currentIsP1 ? session.p1 : session.p2;
  const defender = currentIsP1 ? session.p2 : session.p1;

  // Normalize lifeIndex to first alive if necessary
  function normalizeLifeIndex(side) {
    if (!side.cards || side.cards.length === 0) return;
    if (side.lifeIndex == null || side.lifeIndex >= side.cards.length || side.cards[side.lifeIndex].health <= 0) {
      const idx = side.cards.findIndex(c => c.health > 0);
      side.lifeIndex = idx === -1 ? side.cards.length : idx;
    }
  }
  normalizeLifeIndex(attacker);
  normalizeLifeIndex(defender);

  // Check if defender is alive
  if (defender.lifeIndex >= defender.cards.length) {
    // Attacker won
    await endDuel(sessionId, attacker, defender, channel);
    return;
  }

  // Helper to render HP bar
  function renderHP(cur, max, len = 10) {
    const ratio = max > 0 ? cur / max : 0;
    const filled = Math.max(0, Math.min(len, Math.round(ratio * len)));
    return '█'.repeat(filled) + '░'.repeat(len - filled);
  }

  // Build character list text with modern UI (no emojis)
  const lines = attacker.cards.map((c, idx) => {
    const name = c.card.name;
    const hp = Math.max(0, c.health);
    return `**${idx + 1}. ${name}** — HP: ${hp}/${c.maxHealth} ${renderHP(hp, c.maxHealth)}`;
  }).join('\n');

  const embed = makeEmbed(
    "Your Turn",
    `${attacker.user}, choose a character to attack with!\n\n${lines}`
  );

  // Buttons for characters (disable dead ones)
  const charButtons = attacker.cards.map((card, idx) => {
    return new ButtonBuilder()
      .setCustomId(`duel_selectchar:${sessionId}:${idx}`)
      .setLabel(`${card.card.name}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(card.health <= 0);
  });

  const rows = [];
  for (let i = 0; i < charButtons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(charButtons.slice(i, i + 5)));
  }

  const msg = await channel.send({ embeds: [embed], components: rows });

  const filter = (i) => i.user.id === attacker.userId;
  const collector = msg.createMessageComponentCollector({ filter, time: 30000 });

  collector.on("collect", async i => {
    if (!i.customId.startsWith("duel_selectchar")) return;
    
    await i.deferUpdate();
    const charIdx = parseInt(i.customId.split(":")[2]);

    // Check if selected character is dead
    if (attacker.cards[charIdx].health <= 0) {
      await i.followUp({ content: "That character is already defeated!", ephemeral: true });
      return;
    }

    // Selected character - now choose attack type
    await selectAttackType(sessionId, charIdx, msg, attacker, channel);
  });

  collector.on("end", async (collected) => {
    if (collected.size === 0) {
      // Timeout - skip turn
      session.currentTurn = defender.userId;
      await msg.delete().catch(() => {});
      await startDuelTurn(sessionId, channel);
    }
  });
}

async function selectAttackType(sessionId, charIdx, msg, attacker, channel) {
  const session = DUEL_SESSIONS.get(sessionId);
  if (!session) return;

  const defender = session.currentTurn === session.p1.userId ? session.p2 : session.p1;
  const card = attacker.cards[charIdx];

  const hasSpecial = !!card.card.specialAttack;
  const normalRange = card.scaled ? card.scaled.attackRange : (card.card.attackRange || [0,0]);
  const specialRange = card.scaled && card.scaled.specialAttack ? card.scaled.specialAttack.range : (card.card.specialAttack ? card.card.specialAttack.range : null);
  const embed = makeEmbed(
    "Choose Attack",
    `${card.card.name} is attacking!\n\n**Normal Attack:** ${normalRange[0]}-${normalRange[1]} damage\n${hasSpecial ? `**Special Attack:** ${card.card.specialAttack.name} (${specialRange[0]}-${specialRange[1]} damage)` : "No special attack available"}`
  );

  const buttons = [
    new ButtonBuilder().setCustomId(`duel_attack:${sessionId}:${charIdx}:normal`).setLabel("Normal").setStyle(ButtonStyle.Primary),
  ];

  if (hasSpecial) {
    buttons.push(new ButtonBuilder().setCustomId(`duel_attack:${sessionId}:${charIdx}:special`).setLabel("Special").setStyle(ButtonStyle.Danger));
  }

  const row = new ActionRowBuilder().addComponents(...buttons);

  try {
    await msg.edit({ embeds: [embed], components: [row] });
  } catch (e) {}

  const filter = (i) => i.user.id === attacker.userId;
  const collector = msg.createMessageComponentCollector({ filter, time: 30000 });

  collector.on("collect", async i => {
    if (!i.customId.startsWith("duel_attack")) return;
    
    await i.deferUpdate();
    const attackType = i.customId.split(":")[3];

    // Now select target
    await selectTarget(sessionId, charIdx, attackType, msg, attacker, defender, channel);
  });

  collector.on("end", async (collected) => {
    if (collected.size === 0) {
      // Timeout - skip turn
      session.currentTurn = defender.userId;
      await msg.delete().catch(() => {});
      await startDuelTurn(sessionId, channel);
    }
  });
}

async function selectTarget(sessionId, charIdx, attackType, msg, attacker, defender, channel) {
  const session = DUEL_SESSIONS.get(sessionId);
  if (!session) return;

  const attackerCard = attacker.cards[charIdx];

  // Build target selection
  const targetButtons = defender.cards.map((card, idx) => {
    return new ButtonBuilder()
      .setCustomId(`duel_target:${sessionId}:${charIdx}:${attackType}:${idx}`)
      .setLabel(`${card.card.name} (${card.health}HP)`)
      .setStyle(ButtonStyle.Secondary);
  });

  const embed = makeEmbed(
    "Select Target",
    `Choose which opponent character to attack!`
  );

  const rows = [];
  for (let i = 0; i < targetButtons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(targetButtons.slice(i, i + 5)));
  }

  try {
    await msg.edit({ embeds: [embed], components: rows });
  } catch (e) {}

  const filter = (i) => i.user.id === attacker.userId;
  const collector = msg.createMessageComponentCollector({ filter, time: 30000 });

  collector.on("collect", async i => {
    if (!i.customId.startsWith("duel_target")) return;
    
    await i.deferUpdate();
    const targetIdx = parseInt(i.customId.split(":")[4]);

    // Execute attack
    await executeAttack(sessionId, charIdx, attackType, targetIdx, msg, attacker, defender, channel);
  });

  collector.on("end", async (collected) => {
    if (collected.size === 0) {
      // Timeout - skip turn
      session.currentTurn = defender.userId;
      await msg.delete().catch(() => {});
      await startDuelTurn(sessionId, channel);
    }
  });
}

async function executeAttack(sessionId, charIdx, attackType, targetIdx, msg, attacker, defender, channel) {
  const session = DUEL_SESSIONS.get(sessionId);
  if (!session) return;

  const attackerCard = attacker.cards[charIdx];
  const targetCard = defender.cards[targetIdx];
  const isP1 = attacker === session.p1;

  let damage = 0;
  let isMiss = false;
  let isSpecial = false;

  if (attackType === "normal") {
    // 5% miss chance
    if (Math.random() < 0.05) {
      isMiss = true;
    } else {
      const range = attackerCard.scaled ? attackerCard.scaled.attackRange : (attackerCard.card.attackRange || [0,0]);
      damage = randInt(range[0], range[1]);
    }
  } else {
    // Special attack: 60% normal, 20% special, 20% miss
    const rand = Math.random();
    const normalRange = attackerCard.scaled ? attackerCard.scaled.attackRange : (attackerCard.card.attackRange || [0,0]);
    const specialRange = attackerCard.scaled && attackerCard.scaled.specialAttack ? attackerCard.scaled.specialAttack.range : (attackerCard.card.specialAttack ? attackerCard.card.specialAttack.range : null);
    if (rand < 0.60) {
      damage = randInt(normalRange[0], normalRange[1]);
    } else if (rand < 0.80 && specialRange) {
      isSpecial = true;
      damage = randInt(specialRange[0], specialRange[1]);
    } else {
      isMiss = true;
    }
  }

  // If target already dead, ignore and inform
  if (targetCard.health <= 0) {
    await msg.followUp({ content: "That target is already knocked out.", ephemeral: true });
    return;
  }

  // Apply damage
  targetCard.health = Math.max(0, targetCard.health - damage);

  // Build result message
  const resultText = isMiss
    ? `${attackerCard.card.name} missed! 0 damage`
    : isSpecial
    ? `${attackerCard.card.name} used ${attackerCard.card.specialAttack ? attackerCard.card.specialAttack.name : 'special'}! ${damage} damage`
    : `${attackerCard.card.name} attacks for ${damage} damage`;

  // Render HP bar for target
  function renderHP(cur, max, len = 10) {
    const ratio = max > 0 ? cur / max : 0;
    const filled = Math.max(0, Math.min(len, Math.round(ratio * len)));
    return '█'.repeat(filled) + '░'.repeat(len - filled);
  }

  const embed = makeEmbed(
    "Attack Result",
    `${resultText}\n\n${targetCard.card.name} HP: ${Math.max(0, targetCard.health)}/${targetCard.maxHealth} ${renderHP(Math.max(0, targetCard.health), targetCard.maxHealth)}`
  );

  try {
    await msg.edit({ embeds: [embed], components: [] });
  } catch (e) {}

  // If target was KO'd, normalize defender lifeIndex to first alive
  if (targetCard.health <= 0) {
    const idx = defender.cards.findIndex(c => c.health > 0);
    defender.lifeIndex = idx === -1 ? defender.cards.length : idx;
  }

  // Delay and continue turn or switch to next player
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Check if all opponent's cards are dead
  const allDead = defender.cards.every(card => card.health <= 0);
  if (allDead) {
    // Attacker won
    await endDuel(sessionId, attacker, defender, channel);
  } else {
    // Switch to defender's turn
    session.currentTurn = defender.userId;
    await startDuelTurn(sessionId, channel);
  }
}

async function endDuel(sessionId, winner, loser, channel) {
  const session = DUEL_SESSIONS.get(sessionId);
  if (!session) return;

  // Calculate bounty based on XP difference
  const winnerBal = await Balance.findOne({ userId: winner.userId });
  const loserBal = await Balance.findOne({ userId: loser.userId });

  const bountyMin = Math.max(100, Math.floor((loserBal.xp || 0) * 0.1));
  const bountyMax = Math.max(200, Math.floor((loserBal.xp || 0) * 0.15));
  const bounty = randInt(bountyMin, bountyMax);

  // Add XP (max 100 per day)
  const winDuel = await Duel.findOne({ userId: winner.userId });
  const win = dayWindow();

  const updatedWinDuel = winDuel || new Duel({ userId: winner.userId });
  if (updatedWinDuel.xpWindow !== win) {
    updatedWinDuel.xpWindow = win;
    updatedWinDuel.xpToday = 0;
  }
  if (updatedWinDuel.duelWindow !== win) {
    updatedWinDuel.duelWindow = win;
    updatedWinDuel.duelOpponents = new Map();
  }

  const xpGain = Math.min(10, 100 - (updatedWinDuel.xpToday || 0));
  updatedWinDuel.xpToday = (updatedWinDuel.xpToday || 0) + xpGain;
  updatedWinDuel.duelOpponents.set(loser.userId, (updatedWinDuel.duelOpponents.get(loser.userId) || 0) + 1);
  await updatedWinDuel.save();

  winnerBal.amount += bounty;
  winnerBal.xp = (winnerBal.xp || 0) + xpGain;
  await winnerBal.save();

  // Record quest progress
  try {
    const [dailyQuests, weeklyQuests] = await Promise.all([
      Quest.getCurrentQuests("daily"),
      Quest.getCurrentQuests("weekly")
    ]);
    await Promise.all([
      dailyQuests.recordAction(winner.userId, "duel", 1),
      weeklyQuests.recordAction(winner.userId, "duel", 1)
    ]);
  } catch (e) {
    console.error("Failed to record duel quest progress:", e);
  }

  // Update loser's duel count
  const updatedLoseDuel = await Duel.findOne({ userId: loser.userId }) || new Duel({ userId: loser.userId });
  if (updatedLoseDuel.duelWindow !== win) {
    updatedLoseDuel.duelWindow = win;
    updatedLoseDuel.duelOpponents = new Map();
  }
  updatedLoseDuel.duelOpponents.set(winner.userId, (updatedLoseDuel.duelOpponents.get(winner.userId) || 0) + 1);
  await updatedLoseDuel.save();

  const embed = makeEmbed(
    "Duel Finished",
    `${winner.user.username} wins the duel!\n\nBounty: ${bounty}¥\nXP gained: ${xpGain}/100`
  );

  try {
    const msg = await channel.messages.fetch(session.msgId);
    await msg.reply({ embeds: [embed] });
  } catch (e) {
    await channel.send({ embeds: [embed] });
  }

  DUEL_SESSIONS.delete(sessionId);
}
