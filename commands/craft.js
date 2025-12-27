import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import WeaponInventory from "../models/WeaponInventory.js";
import Inventory from "../models/Inventory.js";
import Progress from "../models/Progress.js";
import Balance from "../models/Balance.js";
import { getCardById, cards } from "../cards.js";
import { buildWeaponBlueprintEmbed } from "../lib/weaponEmbed.js";

export const data = new SlashCommandBuilder()
  .setName("craft")
  .setDescription("Craft weapons from blueprints")
  .addStringOption((opt) =>
    opt.setName("weapon").setDescription("Weapon name or ID to craft").setRequired(false)
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

export async function execute(interactionOrMessage, client) {
  const isInteraction = typeof interactionOrMessage.isCommand === "function" || typeof interactionOrMessage.isChatInputCommand === "function";
  const user = isInteraction ? interactionOrMessage.user : interactionOrMessage.author;
  
  // Guard against missing user
  if (!user || !user.id) {
    console.error("Invalid user object in craft command");
    return;
  }
  
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;
  const userId = user.id;

  let weaponQuery = null;
  if (isInteraction) {
    weaponQuery = interactionOrMessage.options.getString("weapon");
  } else {
    const parts = interactionOrMessage.content.trim().split(/\s+/);
    parts.splice(0, 2); // remove prefix and command
    weaponQuery = parts.join(" ") || null;
  }

  // Get user's weapon inventory
  let weaponInv = await WeaponInventory.findOne({ userId });
  if (!weaponInv) {
    weaponInv = new WeaponInventory({ userId, blueprints: {}, weapons: {}, materials: {} });
  }

  // If no weapon specified, show all blueprints
  if (!weaponQuery) {
    let progDoc = await Progress.findOne({ userId });
    if (!progDoc) {
      const reply = "You don't have any weapon blueprints.";
      if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
      else await channel.send(reply);
      return;
    }

    const cardsMap = progDoc.cards instanceof Map ? progDoc.cards : new Map(Object.entries(progDoc.cards || {}));
    const blueprintCards = [];
    
    // Find all blueprint-type cards
    for (const [cardId, entry] of cardsMap.entries()) {
      const card = getCardById(cardId);
      if (card && card.type === "item" && card.ability && card.ability.includes("Blueprint") && (entry.count || 0) > 0) {
        // This is a blueprint card
        const craftedWeapon = card.evolutions && card.evolutions[0] ? getCardById(card.evolutions[0]) : null;
        if (craftedWeapon && craftedWeapon.type === "weapon") {
          blueprintCards.push({ card, weapon: craftedWeapon, count: entry.count });
        }
      }
    }

    if (blueprintCards.length === 0) {
      const reply = "You don't have any weapon blueprints.";
      if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
      else await channel.send(reply);
      return;
    }

    const blueprintLines = [];
    for (const { card, weapon, count } of blueprintCards) {
      
      const requirements = weapon.craftingRequirements?.materials || {};
      // read materials from Inventory
      const inventory = await Inventory.findOne({ userId });
      const invItems = inventory && inventory.items ? (inventory.items instanceof Map ? Object.fromEntries(inventory.items) : inventory.items) : {};
      const requirementsList = Object.entries(requirements)
        .map(([mat, needed]) => {
          const have = invItems?.[mat] || 0;
          const canCraft = have >= needed;
          return `${mat}: ${have}/${needed}${canCraft ? "" : " (need " + (needed - have) + " more)"}`;
        })
        .join(", ");
      
      blueprintLines.push(`**${weapon.name}** (${count} blueprint${count !== 1 ? "s" : ""})\n${requirementsList}`);
    }

    const embed = new EmbedBuilder()
      .setTitle("Your Weapon Blueprints")
      .setColor(0xFFFFFF)
      .setDescription(blueprintLines.join("\n\n") || "No blueprints");

    if (isInteraction) {
      await interactionOrMessage.reply({ embeds: [embed] });
    } else {
      await channel.send({ embeds: [embed] });
    }
    return;
  }

  // Find and craft the weapon
  const weapon = getWeaponById(weaponQuery);
  if (!weapon) {
    const reply = `No weapon matching "${weaponQuery}" found.`;
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
    else await channel.send(reply);
    return;
  }

  // Get progress to check if user has the blueprint card
  let progDoc = await Progress.findOne({ userId });
  if (!progDoc) {
    const reply = `You don't have a blueprint for ${weapon.name}.`;
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
    else await channel.send(reply);
    return;
  }

  const cardsMap = progDoc.cards instanceof Map ? progDoc.cards : new Map(Object.entries(progDoc.cards || {}));
  
  // Find the blueprint card
  const blueprintCard = weapon.evolutions && weapon.evolutions.length > 0 
    ? getCardById(weapon.evolutions[0])  // Blueprint should be in evolutions (backwards evolution)
    : null;
    
  if (!blueprintCard) {
    const reply = `No blueprint found for ${weapon.name}.`;
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
    else await channel.send(reply);
    return;
  }

  // Check if user has the blueprint card
  const blueprintEntry = cardsMap.get(blueprintCard.id) || null;
  if (!blueprintEntry || (blueprintEntry.count || 0) <= 0) {
    const reply = `You don't have a blueprint for **${weapon.name}**.`;
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
    else await channel.send(reply);
    return;
  }

  // Check if user has all materials
  const requirements = weapon.craftingRequirements?.materials || {};

  // get inventory materials
  const inventory = await Inventory.findOne({ userId });
  const invItems = inventory && inventory.items ? (inventory.items instanceof Map ? Object.fromEntries(inventory.items) : inventory.items) : {};
  
  const missingMaterials = [];
  for (const [mat, needed] of Object.entries(requirements)) {
    const have = invItems?.[mat] || 0;
    if (have < needed) {
      missingMaterials.push(`${mat}: have ${have}, need ${needed}`);
    }
  }

  if (missingMaterials.length > 0) {
    const reply = `You're missing materials:\n${missingMaterials.join("\n")}`;
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
    else await channel.send(reply);
    return;
  }

  // Check if user has enough beli for crafting cost
  const craftingCost = weapon.craftingRequirements?.cost || 0;
  if (craftingCost > 0) {
    let balance = await Balance.findOne({ userId });
    if (!balance || (balance.amount || 0) < craftingCost) {
      const needed = craftingCost - (balance?.amount || 0);
      const reply = `You need ${craftingCost}¥ to craft this weapon. You're short by ${needed}¥.`;
      if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true });
      else await channel.send(reply);
      return;
    }
  }

  // Consume the blueprint card (transform it into the weapon)
  blueprintEntry.count = (blueprintEntry.count || 0) - 1;
  if (blueprintEntry.count <= 0) {
    cardsMap.delete(blueprintCard.id);
  } else {
    cardsMap.set(blueprintCard.id, blueprintEntry);
  }

  // Consume materials from Inventory
  for (const [mat, needed] of Object.entries(requirements)) {
    if (inventory && inventory.items) {
      if (typeof inventory.items.get === 'function') {
        const have = inventory.items.get(mat) || 0;
        inventory.items.set(mat, Math.max(0, have - needed));
      } else {
        inventory.items[mat] = Math.max(0, (inventory.items[mat] || 0) - needed);
      }
    }
  }

  // Create the weapon for the user (starting at level 1, not 0)
  if (weaponInv.weapons instanceof Map) {
    weaponInv.weapons.set(weapon.id, { level: 1, xp: 0, equippedTo: null });
  } else {
    weaponInv.weapons[weapon.id] = { level: 1, xp: 0, equippedTo: null };
  }

  // Also record the crafted weapon in the user's Progress so info() sees ownership
  const existingWeaponEntry = cardsMap.get(weapon.id) || null;
  if (existingWeaponEntry) {
    existingWeaponEntry.count = Math.max(1, (existingWeaponEntry.count || 0));
    existingWeaponEntry.acquiredAt = existingWeaponEntry.acquiredAt || Date.now();
    cardsMap.set(weapon.id, existingWeaponEntry);
  } else {
    const newWeaponEntry = { count: 1, xp: 0, level: 1, acquiredAt: Date.now() };
    cardsMap.set(weapon.id, newWeaponEntry);
  }

  progDoc.cards = cardsMap;
  progDoc.markModified('cards');
  await progDoc.save();
  if (inventory) {
    // if Map-like convert back to object for mongoose
    if (typeof inventory.items.get === 'function') {
      const asObj = {};
      for (const k of inventory.items.keys()) asObj[k] = inventory.items.get(k) || 0;
      inventory.items = asObj;
    }
    inventory.markModified('items');
    await inventory.save();
  }
  await weaponInv.save();

  // Deduct beli if there's a crafting cost
  if (craftingCost > 0) {
    let balance = await Balance.findOne({ userId });
    if (balance) {
      balance.amount = (balance.amount || 0) - craftingCost;
      await balance.save();
    }
  }

  const successEmbed = new EmbedBuilder()
    .setTitle("Weapon Crafted!")
    .setColor(0x00FF00)
    .setDescription(`You successfully crafted **${weapon.name}**! Blueprint consumed.`);

  if (isInteraction) {
    await interactionOrMessage.reply({ embeds: [successEmbed] });
  } else {
    await channel.send({ embeds: [successEmbed] });
  }
}

export const description = "Craft weapons from blueprints";
