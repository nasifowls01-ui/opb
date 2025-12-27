import {
  SlashCommandBuilder,
  EmbedBuilder,
} from "discord.js";
import WeaponInventory from "../models/WeaponInventory.js";
import Progress from "../models/Progress.js";
import { getCardById, cards } from "../cards.js";

export const data = new SlashCommandBuilder()
  .setName("equip")
  .setDescription("Equip a weapon to a card")
  .addStringOption((opt) =>
    opt.setName("weapon").setDescription("Weapon name or ID").setRequired(true)
  )
  .addStringOption((opt) =>
    opt.setName("card").setDescription("Card name or ID to equip to").setRequired(true)
  );

function getWeaponById(weaponId) {
  if (!weaponId) return null;
  const q = String(weaponId).toLowerCase();
  let weapon = cards.find((c) => c.type === "weapon" && c.id.toLowerCase() === q);
  if (weapon) return weapon;
  weapon = cards.find((c) => c.type === "weapon" && c.name.toLowerCase() === q);
  if (weapon) return weapon;
  weapon = cards.find((c) => c.type === "weapon" && c.name.toLowerCase().startsWith(q));
  if (weapon) return weapon;
  weapon = cards.find((c) => c.type === "weapon" && (c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)));
  return weapon || null;
}

function getCardByQuery(query) {
  if (!query) return null;
  const q = String(query).toLowerCase();
  let card = cards.find((c) => c.type !== "weapon" && c.id.toLowerCase() === q);
  if (card) return card;
  card = cards.find((c) => c.type !== "weapon" && c.name.toLowerCase() === q);
  if (card) return card;
  card = cards.find((c) => c.type !== "weapon" && c.name.toLowerCase().startsWith(q));
  if (card) return card;
  card = cards.find((c) => c.type !== "weapon" && (c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q)));
  return card || null;
}

export async function execute(interactionOrMessage, client) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  
  // Guard against missing user
  if (!user || !user.id) {
    console.error("Invalid user object in equip command");
    return;
  }
  
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;

  let weaponQuery, cardQuery;
  
  if (isInteraction) {
    weaponQuery = interactionOrMessage.options.getString("weapon");
    cardQuery = interactionOrMessage.options.getString("card");
  } else {
    const parts = interactionOrMessage.content.trim().split(/\s+/);
    parts.splice(0, 2); // remove prefix and command
    // Format: op equip weaponName cardName or op equip weaponName "card name"
    if (parts.length < 2) {
      await interactionOrMessage.channel.send("Usage: `op equip <weapon> <card>`");
      return;
    }
    const weaponPart = parts[0];
    const cardPart = parts.slice(1).join(" ");
    weaponQuery = weaponPart;
    cardQuery = cardPart;
  }

  // Find weapon
  const weapon = getWeaponById(weaponQuery);
  if (!weapon) {
    const reply = `You don't own **${weaponQuery}** or it doesn't exist.`;
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
    else await interactionOrMessage.channel.send(reply);
    return;
  }

  // Find card
  const card = getCardByQuery(cardQuery);
  if (!card) {
    const reply = `No card matching "${cardQuery}" found.`;
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
    else await channel.send(reply);
    return;
  }

  // Check if card is combat type
  if (card.type !== "Attack" && card.type !== "Defense" && card.type !== "Combat") {
    const reply = `You can only equip weapons to Combat cards. ${card.name} is a ${card.type} card.`;
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
    else await channel.send(reply);
    return;
  }

  // Get user's weapon inventory
  let weaponInv = await WeaponInventory.findOne({ userId });
  if (!weaponInv) {
    const reply = `You don't have **${weapon.name}** crafted.`;
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
    else await channel.send(reply);
    return;
  }

  // Check if user has the weapon
  const userWeapon = weaponInv.weapons instanceof Map ? weaponInv.weapons.get(weapon.id) : weaponInv.weapons?.[weapon.id];
  if (!userWeapon) {
    const reply = `You don't own **${weapon.name}**.`;
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
    else await channel.send(reply);
    return;
  }

  // Check if user owns the card
  const progDoc = await Progress.findOne({ userId });
  const cardsMap = progDoc ? (progDoc.cards instanceof Map ? progDoc.cards : new Map(Object.entries(progDoc.cards || {}))) : new Map();
  let ownedEntry = null;
  
  if (cardsMap instanceof Map) {
    ownedEntry = cardsMap.get(card.id) || null;
  } else {
    ownedEntry = cardsMap[card.id] || null;
  }

  if (!ownedEntry || (ownedEntry.count || 0) <= 0) {
    const reply = `You don't own ${card.name}.`;
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
    else await channel.send(reply);
    return;
  }

  // Prevent re-equipping the same weapon and prevent multiple weapons on the same card
  if (userWeapon.equippedTo === card.id) {
    const reply = `**${weapon.name}** is already equipped to **${card.name}**.`;
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
    else await channel.send(reply);
    return;
  }

  // Check whether another weapon is already equipped to this card
  let otherEquipped = null;
  if (weaponInv.weapons instanceof Map) {
    for (const [wid, w] of weaponInv.weapons.entries()) {
      if (w && w.equippedTo === card.id) { otherEquipped = wid; break; }
    }
  } else {
    for (const [wid, w] of Object.entries(weaponInv.weapons || {})) {
      if (w && w.equippedTo === card.id) { otherEquipped = wid; break; }
    }
  }
  if (otherEquipped && otherEquipped !== weapon.id) {
    const otherName = getCardById(otherEquipped)?.name || otherEquipped;
    const reply = `That card already has **${otherName}** equipped. Unequip it first.`;
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
    else await channel.send(reply);
    return;
  }

  // Equip the weapon
  if (weaponInv.weapons instanceof Map) {
    userWeapon.equippedTo = card.id;
    weaponInv.weapons.set(weapon.id, userWeapon);
  } else {
    weaponInv.weapons[weapon.id].equippedTo = card.id;
  }

  // Ensure Mongoose notices the change and persist
  try {
    weaponInv.markModified && weaponInv.markModified('weapons');
    await weaponInv.save();
  } catch (err) {
    console.error('Failed to save weapon inventory on equip:', err);
    const reply = `Failed to equip **${weapon.name}** to **${card.name}**. Try again later.`;
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
    else await channel.send(reply);
    return;
  }

  // Verify persistence: re-fetch the inventory and confirm equippedTo saved
  const freshInv = await WeaponInventory.findOne({ userId });
  let persisted = false;
  if (freshInv) {
    const w = freshInv.weapons instanceof Map ? freshInv.weapons.get(weapon.id) : freshInv.weapons?.[weapon.id];
    if (w && w.equippedTo === card.id) persisted = true;
  }
  if (!persisted) {
    const reply = `Failed to equip **${weapon.name}** to **${card.name}** (could not verify).`;
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
    else await channel.send(reply);
    return;
  }

  const boostMultiplier = weapon.signatureCards && weapon.signatureCards.includes(card.id) ? 1.25 : 1;
  const boostText = boostMultiplier === 1.25 ? " (25% signature boost applied!)" : "";

  const embed = new EmbedBuilder()
    .setTitle("Weapon Equipped!")
    .setColor(0x00FF00)
    .setDescription(`**${weapon.name}** has been equipped to **${card.name}**${boostText}`);

  if (isInteraction) {
    await interactionOrMessage.reply({ embeds: [embed] });
  } else {
    await channel.send({ embeds: [embed] });
  }
}

export const description = "Equip a weapon to a card";
