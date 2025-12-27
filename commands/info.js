import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import Progress from "../models/Progress.js";
import WeaponInventory from "../models/WeaponInventory.js";
import { buildWeaponEmbed, buildUserWeaponEmbed } from "../lib/weaponEmbed.js";
import { cards, getCardById, getRankInfo } from "../cards.js";
import { buildCardEmbed, buildUserCardEmbed } from "../lib/cardEmbed.js";

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

function fuzzyFindCard(query) {
  if (!query) return null;
  const q = String(query).toLowerCase();
  // exact id
  let card = cards.find((c) => c.id.toLowerCase() === q);
  if (card) return card;
  // exact name
  card = cards.find((c) => c.name.toLowerCase() === q);
  if (card) return card;
  // startsWith name
  card = cards.find((c) => c.name.toLowerCase().startsWith(q));
  if (card) return card;
  // includes
  card = cards.find((c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
  return card || null;
}

// use shared embed builder

export const data = new SlashCommandBuilder()
  .setName("info")
  .setDescription("View a card's info")
  .addStringOption((opt) => opt.setName("card").setDescription("Card id or name").setRequired(true));

export async function execute(interactionOrMessage, client) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;

  // get query
  let query;
  if (isInteraction) {
    query = interactionOrMessage.options.getString("card");
  } else {
    // message content: op info <query...>
    const parts = interactionOrMessage.content.trim().split(/\s+/);
    parts.splice(0, 2); // remove prefix and command
    query = parts.join(" ");
  }

  let card = fuzzyFindCard(query);
  if (!card) {
    const reply = `No card matching "${query}" found.`;
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
    else await channel.send(reply);
    return;
  }

  // fetch progress to check ownership
  const progDoc = await Progress.findOne({ userId });
  const cardsMap = progDoc ? (progDoc.cards instanceof Map ? progDoc.cards : new Map(Object.entries(progDoc.cards || {}))) : new Map();
  // robust ownership lookup: try exact key, lowercase key, and substring matches
  let ownedEntry = null;
  if (cardsMap instanceof Map) {
    ownedEntry = cardsMap.get(card.id) || cardsMap.get(String(card.id).toLowerCase()) || null;
    if (!ownedEntry) {
      for (const [k, v] of cardsMap.entries()) {
        if (String(k).toLowerCase() === String(card.id).toLowerCase() || String(k).toLowerCase().includes(String(card.id).toLowerCase())) {
          ownedEntry = v; break;
        }
      }
    }
  } else {
    // object case (shouldn't normally happen here), but handle defensively
    const obj = Object.fromEntries(cardsMap instanceof Map ? cardsMap : (Object.entries(cardsMap || {})));
    ownedEntry = obj[card.id] || obj[String(card.id).toLowerCase()] || null;
    if (!ownedEntry) {
      for (const k of Object.keys(obj)) {
        if (String(k).toLowerCase() === String(card.id).toLowerCase() || String(k).toLowerCase().includes(String(card.id).toLowerCase())) {
          ownedEntry = obj[k]; break;
        }
      }
    }
  }

  // If multiple upgrade variants share the same name and the user owns a higher one,
  // prefer showing the highest owned variant when the query is ambiguous (e.g., "nami").
  const sameNameVariants = cards.filter(c => (c.name || "").toLowerCase() === (card.name || "").toLowerCase());
  if (sameNameVariants.length > 1) {
    let bestOwned = null;
    for (const v of sameNameVariants) {
      const ent = cardsMap.get(v.id);
      if (ent && (ent.count || 0) > 0) {
        if (!bestOwned) bestOwned = v;
        else {
          const va = getRankInfo(v.rank)?.value || 0;
          const vb = getRankInfo(bestOwned.rank)?.value || 0;
          if (va > vb) bestOwned = v;
        }
      }
    }
    if (bestOwned) {
      // switch to the owned higher variant
      card = bestOwned;
      ownedEntry = cardsMap.get(card.id) || null;
    }
  }

  // If the target is a weapon, show its weapon-specific embed (user-specific if crafted)
  if (card.type && String(card.type).toLowerCase() === "weapon") {
    const winv = await WeaponInventory.findOne({ userId });
    const userWeapon = winv ? (winv.weapons instanceof Map ? winv.weapons.get(card.id) : winv.weapons?.[card.id]) : null;
    
    // Check if this is a signature weapon equipped to its card
    let isSignatureBoosted = false;
    if (userWeapon && userWeapon.equippedTo) {
      const equippedCard = getCardById(userWeapon.equippedTo);
      if (equippedCard && equippedCard.signatureWeapon === card.id) {
        isSignatureBoosted = true;
      }
    }
    
    const weaponEmbed = userWeapon ? buildUserWeaponEmbed(card, userWeapon, user, isSignatureBoosted) : buildWeaponEmbed(card, user);
    if (!weaponEmbed) {
      const reply = `Unable to display weapon info for ${card.name}.`;
      if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true }); else await channel.send(reply);
      return;
    }
    // Build buttons: allow viewing user stats if player crafted this weapon
    const rows = [];
    const buttons = [];
    buttons.push(
      new (await import("discord.js")).ButtonBuilder()
        .setCustomId(`info_weaponbase:${userId}:${card.id}`)
        .setLabel("Base Stats")
        .setStyle((await import("discord.js")).ButtonStyle.Secondary)
    );
    if (userWeapon) {
      buttons.push(
        new (await import("discord.js")).ButtonBuilder()
          .setCustomId(`info_userweapon:${userId}:${card.id}`)
          .setLabel("Your stats")
          .setStyle((await import("discord.js")).ButtonStyle.Primary)
      );
    }
    rows.push(new (await import("discord.js")).ActionRowBuilder().addComponents(...buttons));

    // If user doesn't own the crafted weapon, keep embed greyed
    if (!userWeapon) weaponEmbed.setColor(0x2f3136);
    if (isInteraction) await interactionOrMessage.reply({ embeds: [weaponEmbed], components: rows }); else await channel.send({ embeds: [weaponEmbed], components: rows });
    return;
  }

  const embed = buildCardEmbed(card, ownedEntry, user);

  // Get equipped weapon if user owns the card
  let equippedWeapon = null;
  if (ownedEntry && (ownedEntry.count || 0) > 0) {
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
  }

  // if not owned, make it grey but keep full info visible
  if (!ownedEntry || (ownedEntry.count || 0) <= 0) {
    embed.setColor(0x2f3136);

    // Check if this card is a lower version of an upgrade owned by user
    // Only block viewing when the user does NOT own the requested card
    const chain = getEvolutionChain(card);
    let ownedHigherId = null;
    for (let i = chain.indexOf(card.id) + 1; i < chain.length; i++) {
      const higherCardId = chain[i];
      const higherEntry = cardsMap.get(higherCardId);
      if (higherEntry && (higherEntry.count || 0) > 0) {
        ownedHigherId = higherCardId;
        break;
      }
    }
    if ((!ownedEntry || (ownedEntry.count || 0) <= 0) && ownedHigherId) {
      const ownedHigherCard = getCardById(ownedHigherId);
      const reply = `You own a higher version of this card. You can only view: ${ownedHigherCard?.name || 'upgraded version'}.`;
      if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true }); else await channel.send(reply);
      return;
    }
  }

  // build evolution chain (root then recursive evolutions)
  const chain = getEvolutionChain(card);
  const len = chain.length;
  const rows = [];
  
  // Create buttons row with Previous/Next and User Stats button
  const buttons = [];
  if (len > 1) {
    const idx = 0;
    const prevIndex = (idx - 1 + len) % len;
    const nextIndex = (idx + 1) % len;
    const prevId = `info_prev:${userId}:${card.id}:${prevIndex}`;
    const nextId = `info_next:${userId}:${card.id}:${nextIndex}`;
    buttons.push(
      new ButtonBuilder().setCustomId(prevId).setLabel("Previous").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(nextId).setLabel("Next").setStyle(ButtonStyle.Secondary)
    );
  }
  
  // Add user stats button (shows for all cards, but refuses on click if not owned)
  // Add user stats button only for owned cards
  if (ownedEntry && (ownedEntry.count || 0) > 0) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`info_userstats:${userId}:${card.id}`)
        .setLabel("Your stats")
        .setStyle(ButtonStyle.Primary)
    );
  }
  
  if (buttons.length > 0) {
    rows.push(new ActionRowBuilder().addComponents(...buttons));
  }

  if (isInteraction) {
    if (rows.length > 0) await interactionOrMessage.reply({ embeds: [embed], components: rows });
    else await interactionOrMessage.reply({ embeds: [embed] });
  } else {
    if (rows.length > 0) await channel.send({ embeds: [embed], components: rows });
    else await channel.send({ embeds: [embed] });
  }
}
