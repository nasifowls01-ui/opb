import Progress from "../models/Progress.js";
import { getCardById, getRankInfo } from "../cards.js";
import { buildCardEmbed, buildUserCardEmbed } from "../lib/cardEmbed.js";
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from "discord.js";

export const name = "interactionCreate";
export const once = false;

// use shared embed builder to keep UI consistent across commands and interactions

function getEvolutionChain(rootCard) {
  const chain = [];
  const visited = new Set();
  function walk(card) {
    if (!card || visited.has(card.id)) return;
    visited.add(card.id);
    chain.push(card.id);
    const ev = card.evolutions || [];
    for (const nextId of ev) {
      const next = getCardById(nextId);
      if (next) walk(next);
    }
  }
  walk(rootCard);
  return chain;
}

export async function execute(interaction, client) {
  // handle component interactions (buttons) first
  try {
    // handle select menus first
    if (interaction.isStringSelectMenu && interaction.isStringSelectMenu()) {
      const id = interaction.customId || "";
      if (id.startsWith("collection_sort:")) {
        const parts = id.split(":");
        const ownerId = parts[1];
        if (interaction.user.id !== ownerId) return interaction.reply({ content: "Only the original requester can use this select.", ephemeral: true });

        const sortVal = interaction.values && interaction.values[0] ? interaction.values[0] : 'best';
        // build collection for user with this sort
        const progDoc = await Progress.findOne({ userId: ownerId });
        if (!progDoc || !progDoc.cards) {
          await interaction.reply({ content: "You have no cards.", ephemeral: true });
          return;
        }

        const cardsMap = progDoc.cards instanceof Map ? progDoc.cards : new Map(Object.entries(progDoc.cards || {}));
        const items = [];
        for (const [cardId, entry] of cardsMap.entries()) {
          const card = getCardById(cardId);
          if (!card) continue;
          items.push({ card, entry });
        }

        function computeScoreLocal(card, entry) {
          const level = entry.level || 0;
          const multiplier = 1 + level * 0.01;
          const power = (card.power || 0) * multiplier;
          const health = (card.health || 0) * multiplier;
          return power + health * 0.2;
        }

        if (sortVal === 'best') items.sort((a, b) => computeScoreLocal(b.card, b.entry) - computeScoreLocal(a.card, a.entry));
        else if (sortVal === 'wtb') items.sort((a, b) => computeScoreLocal(a.card, a.entry) - computeScoreLocal(b.card, b.entry));
        else if (sortVal === 'lbtw') items.sort((a, b) => (b.entry.level || 0) - (a.entry.level || 0));
        else if (sortVal === 'lwtb') items.sort((a, b) => (a.entry.level || 0) - (b.entry.level || 0));
        else if (sortVal === 'rank') items.sort((a, b) => (getRankInfo(b.card.rank)?.value || 0) - (getRankInfo(a.card.rank)?.value || 0));
        else if (sortVal === 'nto') items.sort((a, b) => (b.entry.acquiredAt || 0) - (a.entry.acquiredAt || 0));
        else if (sortVal === 'otn') items.sort((a, b) => (a.entry.acquiredAt || 0) - (b.entry.acquiredAt || 0));

        const PAGE_SIZE = 5;
        const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
        const page = 0;
        const pageItems = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
        const lines = pageItems.map((it, idx) => {
          const card = it.card;
          const entry = it.entry;
          const level = entry.level || 0;
          const power = Math.round((card.power || 0) * (1 + level * 0.01));
          const attack = `${Math.round((card.attackRange?.[0] || 0) * (1 + level * 0.01))} - ${Math.round((card.attackRange?.[1] || 0) * (1 + level * 0.01))}`;
          const health = Math.round((card.health || 0) * (1 + level * 0.01));
          return `**${idx + 1}. ${card.name}** (Lv ${level}) — Power: ${power} | Attack: ${attack} | HP: ${health}`;
        });

        const embed = new EmbedBuilder().setTitle('Collection').setDescription(lines.join('\n')).setFooter({ text: `Page ${page + 1}/${totalPages}` });

        // recreate sort menu and paging buttons
        const sortMenu = new StringSelectMenuBuilder()
          .setCustomId(`collection_sort:${ownerId}`)
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
        const prevId = `collection_prev:${ownerId}:${sortVal}:${page}`;
        const nextId = `collection_next:${ownerId}:${sortVal}:${page}`;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(prevId).setLabel('Previous').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(nextId).setLabel('Next').setStyle(ButtonStyle.Secondary)
        );

        await interaction.update({ embeds: [embed], components: [sortRow, row] });
        return;
      }
    }

    if (interaction.isButton()) {
      const id = interaction.customId || "";
      // only handle known prefixes
      if (!id.startsWith("info_") && !id.startsWith("collection_") && !id.startsWith("quest_") && !id.startsWith("help_")) return;

      const parts = id.split(":");
      if (parts.length < 2) return;
      const action = parts[0];
      const ownerId = parts[1];

      // HELP category buttons: help_cat:<category>:<userId>
      if (id.startsWith("help_cat")) {
        const parts = id.split(":");
        const category = parts[1];
        const userId = parts[2];
        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        // Static help groups (match commands provided by owner)
        const groups = {
          COMBAT: [
            { name: "team", desc: "view your team" },
            { name: "team add", desc: "add a card to your team" },
            { name: "team remove", desc: "remove a card from your team" },
            { name: "autoteam", desc: "builds the best possible team (powerwise)" },
            { name: "upgrade", desc: "upgrade a card to its next rank" }
          ],
          ECONOMY: [
            { name: "balance", desc: "shows your balance and reset token count" },
            { name: "daily", desc: "claim daily rewards" },
            { name: "gamble", desc: "gamble an amount of beli" },
            { name: "mission", desc: "one piece trivia questions that give you rewards" },
            { name: "quests", desc: "view your daily and weekly quests" },
            { name: "sell", desc: "sell a card or item for beli" }
          ],
          COLLECTION: [
            { name: "info", desc: "view info about a card or item" },
            { name: "pull", desc: "pull a random card" },
            { name: "resetpulls", desc: "resets your card pull count" }
          ],
          GENERAL: [
            { name: "help", desc: "shows all bot commands" },
            { name: "inventory", desc: "view your inventory items" },
            { name: "level", desc: "use XP books/scrolls to level up a card" },
            { name: "user", desc: "shows your user profile" }
          ]
        };

        if (!groups[category]) {
          await interaction.reply({ content: "Category not found.", ephemeral: true });
          return;
        }

        const lines = groups[category].map(c => `**${c.name}** — ${c.desc}`).join("\n") || "No commands";
        const embed = new EmbedBuilder()
          .setTitle(`${category} Commands`)
          .setColor(0xFFFFFF)
          .setDescription(lines)
          .setFooter({ text: `Requested by ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() });

        // build buttons for all categories, mark selected as primary
        const order = ["COMBAT", "ECONOMY", "COLLECTION", "GENERAL"];
        const allButtons = order.map(cat => new ButtonBuilder()
          .setCustomId(`help_cat:${cat}:${userId}`)
          .setLabel(cat.charAt(0) + cat.slice(1).toLowerCase())
          .setStyle(cat === category ? ButtonStyle.Primary : ButtonStyle.Secondary)
        );

        const rows = [];
        for (let i = 0; i < allButtons.length; i += 5) {
          rows.push(new ActionRowBuilder().addComponents(...allButtons.slice(i, i + 5)));
        }

        await interaction.update({ embeds: [embed], components: rows });
        return;
      }

      // Handle quest view/claim buttons
      if (action === "quest_view") {
        // customId format from command: quest_view:<type>:<userId>
        const questType = parts[1]; // daily or weekly
        const userId = parts[2];

        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        const Quest = (await import("../models/Quest.js")).default;
        let questDoc = await Quest.getCurrentQuests(questType);
        
        if (!questDoc.quests.length) {
          const { generateQuests } = await import("../lib/quests.js");
          questDoc.quests = generateQuests(questType);
          await questDoc.save();
        }

        const questEmbed = await (await import("../commands/quests.js")).buildQuestEmbed(questDoc, interaction.user);

        const row = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(`quest_view:daily:${userId}`)
              .setLabel("Daily")
              .setStyle(questType === "daily" ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(`quest_view:weekly:${userId}`)
              .setLabel("Weekly")
              .setStyle(questType === "weekly" ? ButtonStyle.Primary : ButtonStyle.Secondary)
          );

        const claimRow = new ActionRowBuilder()
          .addComponents(
            new ButtonBuilder()
              .setCustomId(`quest_claim:${userId}`)
              .setLabel("Claim Completed")
              .setStyle(ButtonStyle.Success)
          );

        await interaction.update({
          embeds: [questEmbed],
          components: [row, claimRow]
        });
        return;
      }

      if (action === "quest_claim") {
        const userId = parts[1];
        
        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        const Quest = (await import("../models/Quest.js")).default;
        const Balance = (await import("../models/Balance.js")).default;
        const { calculateQuestRewards } = await import("../lib/quests.js");

        // Get both daily and weekly quests
        const [dailyQuests, weeklyQuests] = await Promise.all([
          Quest.getCurrentQuests("daily"),
          Quest.getCurrentQuests("weekly")
        ]);

        let claimed = 0;
        let totalMoney = 0;
        let totalChests = [];
        let totalResetTokens = 0;

        // Process both quest sets
        for (const questDoc of [dailyQuests, weeklyQuests]) {
          const userProgress = questDoc.getUserProgress(userId);
          
          for (const quest of questDoc.quests) {
            const progress = userProgress.get(quest.id);
            if (!progress || progress.claimed || progress.current < quest.target) continue;

            // Calculate rewards
            const rewards = calculateQuestRewards(quest);
            totalMoney += rewards.money;
            totalChests.push(...rewards.chests);
            totalResetTokens += rewards.resetTokens;

            // Mark as claimed
            progress.claimed = true;
            userProgress.set(quest.id, progress);
            claimed++;
          }

          if (claimed > 0) {
            questDoc.progress.set(userId, userProgress);
            await questDoc.save();
          }
        }

        if (claimed === 0) {
          await interaction.reply({ 
            content: "You have no completed quests to claim.", 
            ephemeral: true 
          });
          return;
        }

        // Update user's balance, XP and inventory
        let bal = await Balance.findOne({ userId });
        if (!bal) bal = new Balance({ userId, amount: 500, xp: 0, level: 0 });

        bal.amount += totalMoney;
        bal.resetTokens = (bal.resetTokens || 0) + totalResetTokens;
        // Award XP for claiming quests (small amount per claimed quest)
        const XP_PER_QUEST = 5;
        bal.xp = (bal.xp || 0) + (claimed * XP_PER_QUEST);
        while ((bal.xp || 0) >= 100) {
          bal.xp -= 100;
          bal.level = (bal.level || 0) + 1;
        }
        await bal.save();

        // Add quest chests to user's inventory
        if (totalChests.length > 0) {
          const Inventory = (await import("../models/Inventory.js")).default;
          let inv = await Inventory.findOne({ userId });
          if (!inv) inv = new Inventory({ userId, items: {}, chests: { C:0, B:0, A:0, S:0 }, xpBottles: 0 });
          inv.chests = inv.chests || { C:0, B:0, A:0, S:0 };
          for (const c of totalChests) {
            const rank = String(c.rank || "C").toUpperCase();
            const count = parseInt(c.count || 0, 10) || 0;
            inv.chests[rank] = (inv.chests[rank] || 0) + count;
          }
          await inv.save();
        }

        const rewardEmbed = new EmbedBuilder()
          .setTitle("Quests Claimed!")
          .setColor(0xFFFFFF)
          .setDescription(
            `You claimed ${claimed} quest${claimed !== 1 ? 's' : ''}!\n\n` +
            `Rewards:\n` +
            `• ${totalMoney}¥\n` +
            (totalResetTokens > 0 ? `• ${totalResetTokens} Reset Token${totalResetTokens !== 1 ? 's' : ''}\n` : '') +
            (totalChests.length > 0 ? `• ${totalChests.map(c => `${c.count}× ${c.rank} Chest${c.count !== 1 ? 's' : ''}`).join(', ')}\n` : '')
          );

        await interaction.reply({ 
          embeds: [rewardEmbed], 
          ephemeral: true 
        });

        // Refresh the quest display
        const questDoc = interaction.message.embeds[0].title.toLowerCase().includes("daily") ? dailyQuests : weeklyQuests;
        const questEmbed = await (await import("../commands/quests.js")).buildQuestEmbed(questDoc, interaction.user);
        
        const components = interaction.message.components;
        await interaction.message.edit({
          embeds: [questEmbed],
          components
        });
        return;
      }

      // INFO paging: support info_prev/info_next customIds with index
      if (action === "info_prev" || action === "info_next") {
          const rootCardId = parts[2];
          const targetIndex = parseInt(parts[3] || "0", 10) || 0;
          const rootCard = getCardById(rootCardId);
          if (!rootCard) {
            await interaction.reply({ content: "Root card not found.", ephemeral: true });
            return;
          }

          const chain = getEvolutionChain(rootCard);
          const len = chain.length;
          if (len === 0) {
            await interaction.reply({ content: "No evolutions available for this card.", ephemeral: true });
            return;
          }

          const idx = ((targetIndex % len) + len) % len;
          const newCardId = chain[idx];
          const newCard = getCardById(newCardId);
          if (!newCard) {
            await interaction.reply({ content: "Evolution card not found.", ephemeral: true });
            return;
          }

          // fetch progress to check ownership
          const progDoc = await Progress.findOne({ userId: ownerId });
          const cardsMap = progDoc ? (progDoc.cards instanceof Map ? progDoc.cards : new Map(Object.entries(progDoc.cards || {}))) : new Map();
          const ownedEntry = cardsMap.get(newCard.id) || null;

          // build embed using shared builder so layout matches info command
          const newEmbed = buildCardEmbed(newCard, ownedEntry, interaction.user);
          if (!ownedEntry || (ownedEntry.count || 0) <= 0) {
            newEmbed.setColor(0x2f3136);

                    // Check if this card is a lower version of an upgrade owned by user
                    // Only block when the user does NOT own the requested card
                    const chainForPag = getEvolutionChain(newCard);
                    let ownedHigherIdForPag = null;
                    for (let i = chainForPag.indexOf(newCard.id) + 1; i < chainForPag.length; i++) {
                      const higherCardId = chainForPag[i];
                      const higherEntry = cardsMap.get(higherCardId);
                      if (higherEntry && (higherEntry.count || 0) > 0) {
                        ownedHigherIdForPag = higherCardId;
                        break;
                      }
                    }
                    if ((!ownedEntry || (ownedEntry.count || 0) <= 0) && ownedHigherIdForPag) {
                      const ownedHigher = getCardById(ownedHigherIdForPag);
                      await interaction.reply({ content: `You own a higher version (${ownedHigher?.name || 'upgraded version'}) and cannot view this version.`, ephemeral: true });
                      return;
                    }
          }

          // compute prev/next indices for this chain and attach buttons
          const prevIndex = (idx - 1 + len) % len;
          const nextIndex = (idx + 1) % len;
          const prevIdNew = `info_prev:${ownerId}:${rootCard.id}:${prevIndex}`;
          const nextIdNew = `info_next:${ownerId}:${rootCard.id}:${nextIndex}`;

          const btns = [
            new ButtonBuilder().setCustomId(prevIdNew).setLabel("Previous").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(nextIdNew).setLabel("Next").setStyle(ButtonStyle.Secondary)
          ];

          // if the user owns this card, add the "Your stats" primary button
          if (ownedEntry && (ownedEntry.count || 0) > 0) {
            btns.push(
              new ButtonBuilder()
                .setCustomId(`info_userstats:${ownerId}:${newCard.id}`)
                .setLabel("Your stats")
                .setStyle(ButtonStyle.Primary)
            );
          }

          const row = new ActionRowBuilder().addComponents(...btns);

          await interaction.update({ embeds: [newEmbed], components: [row] });
          return;
        }

      // INFO user stats: info_userstats:<userId>:<cardId>
      if (action === "info_userstats") {
        const cardId = parts[2];
        const userId = parts[1];

        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        const card = getCardById(cardId);
        if (!card) {
          await interaction.reply({ content: "Card not found.", ephemeral: true });
          return;
        }

        // fetch progress to check ownership
        const progDoc = await Progress.findOne({ userId });
        const cardsMap = progDoc ? (progDoc.cards instanceof Map ? progDoc.cards : new Map(Object.entries(progDoc.cards || {}))) : new Map();
        let ownedEntry = null;
        
        // Try to find the card in user's collection
        if (cardsMap instanceof Map) {
          ownedEntry = cardsMap.get(card.id) || cardsMap.get(String(card.id).toLowerCase()) || null;
          if (!ownedEntry) {
            for (const [k, v] of cardsMap.entries()) {
              if (String(k).toLowerCase() === String(card.id).toLowerCase()) {
                ownedEntry = v; 
                break;
              }
            }
          }
        }

        // Check if user owns the card
        if (!ownedEntry || (ownedEntry.count || 0) <= 0) {
          await interaction.reply({ content: "You don't own this card.", ephemeral: true });
          return;
        }

        // Get equipped weapon if any
        let equippedWeapon = null;
        const WeaponInventory = (await import("../models/WeaponInventory.js")).default;
        const winv = await WeaponInventory.findOne({ userId });
        if (winv && winv.weapons) {
          if (winv.weapons instanceof Map) {
            for (const [wid, w] of winv.weapons.entries()) {
              if (w.equippedTo === card.id) {
                const wcard = getCardById(wid);
                if (wcard) {
                  equippedWeapon = { id: wid, card: wcard, ...w };
                }
                break;
              }
            }
          } else {
            for (const [wid, w] of Object.entries(winv.weapons || {})) {
              if (w && w.equippedTo === card.id) {
                const wcard = getCardById(wid);
                if (wcard) {
                  equippedWeapon = { id: wid, card: wcard, ...w };
                }
                break;
              }
            }
          }
        }

        // Build user card embed
        const userEmbed = buildUserCardEmbed(card, ownedEntry, interaction.user, equippedWeapon);
        if (!userEmbed) {
          await interaction.reply({ content: "Unable to build user card stats.", ephemeral: true });
          return;
        }

        // Build buttons: back to base stats and previous/next
        const buttons = [];
        buttons.push(
          new ButtonBuilder()
            .setCustomId(`info_base:${userId}:${card.id}`)
            .setLabel("Base Stats")
            .setStyle(ButtonStyle.Secondary)
        );

        await interaction.update({ embeds: [userEmbed], components: [new ActionRowBuilder().addComponents(...buttons)] });
        return;
      }

      // INFO user weapon stats: info_userweapon:<userId>:<weaponId>
      if (action === "info_userweapon") {
        const weaponId = parts[2];
        const userId = parts[1];

        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        const WeaponInventory = (await import("../models/WeaponInventory.js")).default;
        const winv = await WeaponInventory.findOne({ userId });
        if (!winv) {
          await interaction.reply({ content: "You don't have any weapons.", ephemeral: true });
          return;
        }

        const userWeapon = winv.weapons instanceof Map ? winv.weapons.get(weaponId) : winv.weapons?.[weaponId];
        if (!userWeapon) {
          await interaction.reply({ content: "You haven't crafted this weapon.", ephemeral: true });
          return;
        }

        const { buildUserWeaponEmbed } = await import("../lib/weaponEmbed.js");
        const weapon = getCardById(weaponId);
        if (!weapon) {
          await interaction.reply({ content: "Weapon not found.", ephemeral: true });
          return;
        }

        // Check if this is a signature weapon equipped to a card
        let isSignatureBoosted = false;
        if (userWeapon.equippedTo) {
          const equippedCard = getCardById(userWeapon.equippedTo);
          if (equippedCard && equippedCard.signatureWeapon === weaponId) {
            isSignatureBoosted = true;
          }
        }

        const embed = buildUserWeaponEmbed(weapon, userWeapon, interaction.user, isSignatureBoosted);
        if (!embed) {
          await interaction.reply({ content: "Unable to build weapon info.", ephemeral: true });
          return;
        }

        // Back button to base stats for weapon
        const back = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`info_weaponbase:${userId}:${weaponId}`).setLabel("Base Stats").setStyle(ButtonStyle.Secondary)
        );

        await interaction.update({ embeds: [embed], components: [back] });
        return;
      }

      // INFO base stats: info_base:<userId>:<cardId>
      if (action === "info_weaponbase") {
        const weaponId = parts[2];
        const userId = parts[1];

        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        const { buildWeaponEmbed, buildUserWeaponEmbed } = await import("../lib/weaponEmbed.js");
        const WeaponInventory = (await import("../models/WeaponInventory.js")).default;

        const weapon = getCardById(weaponId);
        if (!weapon) {
          await interaction.reply({ content: "Weapon not found.", ephemeral: true });
          return;
        }

        const embed = buildWeaponEmbed(weapon, interaction.user);

        // Check if user crafted it
        const winv = await WeaponInventory.findOne({ userId });
        const userWeapon = winv ? (winv.weapons instanceof Map ? winv.weapons.get(weaponId) : winv.weapons?.[weaponId]) : null;

        const buttons = [];
        if (userWeapon) {
          buttons.push(new ButtonBuilder().setCustomId(`info_userweapon:${userId}:${weaponId}`).setLabel("Your stats").setStyle(ButtonStyle.Primary));
        }
        buttons.push(new ButtonBuilder().setCustomId(`info_weaponbase:${userId}:${weaponId}`).setLabel("Base Stats").setStyle(ButtonStyle.Secondary));

        const components = buttons.length ? [new ActionRowBuilder().addComponents(...buttons)] : [];
        await interaction.update({ embeds: [embed], components });
        return;
      }

      if (action === "info_base") {
        const cardId = parts[2];
        const userId = parts[1];

        if (interaction.user.id !== userId) {
          await interaction.reply({ content: "Only the original requester can use these buttons.", ephemeral: true });
          return;
        }

        const card = getCardById(cardId);
        if (!card) {
          await interaction.reply({ content: "Card not found.", ephemeral: true });
          return;
        }

        // fetch progress to check ownership
        const progDoc = await Progress.findOne({ userId });
        const cardsMap = progDoc ? (progDoc.cards instanceof Map ? progDoc.cards : new Map(Object.entries(progDoc.cards || {}))) : new Map();
        let ownedEntry = null;
        
        if (cardsMap instanceof Map) {
          ownedEntry = cardsMap.get(card.id) || cardsMap.get(String(card.id).toLowerCase()) || null;
          if (!ownedEntry) {
            for (const [k, v] of cardsMap.entries()) {
              if (String(k).toLowerCase() === String(card.id).toLowerCase()) {
                ownedEntry = v; 
                break;
              }
            }
          }
        }

        // Build base card embed
        const baseEmbed = buildCardEmbed(card, ownedEntry, interaction.user);
        if (!ownedEntry || (ownedEntry.count || 0) <= 0) {
          baseEmbed.setColor(0x2f3136);
        }

        // Rebuild evolution chain and get current position
        const chain = getEvolutionChain(card);
        const len = chain.length;
        
        // Build buttons: Previous/Next if multiple evolutions exist, plus User Stats if owned
        const buttons = [];
        if (len > 1) {
          const idx = 0;  // Always back to the first (base) card
          const prevIndex = (idx - 1 + len) % len;
          const nextIndex = (idx + 1) % len;
          const prevIdBase = `info_prev:${userId}:${card.id}:${prevIndex}`;
          const nextIdBase = `info_next:${userId}:${card.id}:${nextIndex}`;
          buttons.push(
            new ButtonBuilder()
              .setCustomId(prevIdBase)
              .setLabel("Previous")
              .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
              .setCustomId(nextIdBase)
              .setLabel("Next")
              .setStyle(ButtonStyle.Secondary)
          );
        }
        
        // Add Your Stats button if owned
        if (ownedEntry && (ownedEntry.count || 0) > 0) {
          buttons.push(
            new ButtonBuilder()
              .setCustomId(`info_userstats:${userId}:${card.id}`)
              .setLabel("Your stats")
              .setStyle(ButtonStyle.Primary)
          );
        }

        const components = buttons.length > 0 ? [new ActionRowBuilder().addComponents(...buttons)] : [];
        await interaction.update({ embeds: [baseEmbed], components });
        return;
      }


      // COLLECTION pagination AND select menu handling
      if (action.startsWith("collection_")) {
        const sortKey = parts[2];
        const pageNum = parseInt(parts[3] || "0", 10) || 0;

        const progDoc = await Progress.findOne({ userId: ownerId });
        if (!progDoc || !progDoc.cards) {
          await interaction.reply({ content: "You have no cards.", ephemeral: true });
          return;
        }

        const cardsMap = progDoc.cards instanceof Map ? progDoc.cards : new Map(Object.entries(progDoc.cards || {}));
        const items = [];
        for (const [cardId, entry] of cardsMap.entries()) {
          const card = getCardById(cardId);
          if (!card) continue;
          items.push({ card, entry });
        }

        function computeScoreLocal(card, entry) {
          const level = entry.level || 0;
          const multiplier = 1 + level * 0.01;
          const power = (card.power || 0) * multiplier;
          const health = (card.health || 0) * multiplier;
          return power + health * 0.2;
        }

        if (sortKey === "best") items.sort((a, b) => computeScoreLocal(b.card, b.entry) - computeScoreLocal(a.card, a.entry));
        else if (sortKey === "wtb") items.sort((a, b) => computeScoreLocal(a.card, a.entry) - computeScoreLocal(b.card, b.entry));
        else if (sortKey === "lbtw") items.sort((a, b) => (b.entry.level || 0) - (a.entry.level || 0));
        else if (sortKey === "lwtb") items.sort((a, b) => (a.entry.level || 0) - (b.entry.level || 0));
        else if (sortKey === "rank") items.sort((a, b) => (getRankInfo(b.card.rank)?.value || 0) - (getRankInfo(a.card.rank)?.value || 0));
        else if (sortKey === "nto") items.sort((a, b) => (b.entry.acquiredAt || 0) - (a.entry.acquiredAt || 0));
        else if (sortKey === "otn") items.sort((a, b) => (a.entry.acquiredAt || 0) - (b.entry.acquiredAt || 0));

        const PAGE_SIZE = 5;
        const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
        let newPage = pageNum;
        if (action === "collection_prev") newPage = Math.max(0, pageNum - 1);
        if (action === "collection_next") newPage = Math.min(totalPages - 1, pageNum + 1);

        const pageItems = items.slice(newPage * PAGE_SIZE, (newPage + 1) * PAGE_SIZE);
        const lines = pageItems.map((it, idx) => {
          const card = it.card;
          const entry = it.entry;
          const level = entry.level || 0;
          const power = Math.round((card.power || 0) * (1 + level * 0.01));
          const attack = `${Math.round((card.attackRange?.[0] || 0) * (1 + level * 0.01))} - ${Math.round((card.attackRange?.[1] || 0) * (1 + level * 0.01))}`;
          const health = Math.round((card.health || 0) * (1 + level * 0.01));
          return `**${newPage * PAGE_SIZE + idx + 1}. ${card.name}** (Lv ${level}) — Power: ${power} | Attack: ${attack} | HP: ${health}`;
        });

        const embed = new EmbedBuilder().setTitle("Collection").setDescription(lines.join("\n")).setFooter({ text: `Page ${newPage + 1}/${totalPages}` });
        const prevIdNew = `collection_prev:${ownerId}:${sortKey}:${newPage}`;
        const nextIdNew = `collection_next:${ownerId}:${sortKey}:${newPage}`;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(prevIdNew).setLabel("Previous").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(nextIdNew).setLabel("Next").setStyle(ButtonStyle.Secondary)
        );

        await interaction.update({ embeds: [embed], components: [row] });
        return;
      }
    }
  } catch (err) {
    console.error("Error handling button interaction:", err);
    try {
      if (!interaction.replied) await interaction.reply({ content: "Error handling interaction.", ephemeral: true });
    } catch (e) {}
    return;
  }

  // fallback to chat input commands (slash)
  if (!interaction.isChatInputCommand()) return;
  const command = client.commands.get(interaction.commandName.toLowerCase());
  if (!command) return;

  try {
    await command.execute(interaction, client);
  } catch (error) {
    console.error(error);
    try {
      if (!interaction.replied) await interaction.reply({ content: "There was an error executing this command.", ephemeral: true });
    } catch (e) {}
  }
}
