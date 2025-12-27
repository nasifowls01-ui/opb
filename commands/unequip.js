import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import WeaponInventory from "../models/WeaponInventory.js";
import { getCardById, cards } from "../cards.js";

export const data = new SlashCommandBuilder()
  .setName("unequip")
  .setDescription("Unequip a weapon from a card")
  .addStringOption((opt) =>
    opt.setName("weapon").setDescription("Weapon name or ID to unequip").setRequired(false)
  )
  .addStringOption((opt) =>
    opt.setName("card").setDescription("Card name or ID to unequip from").setRequired(false)
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
  const userId = user.id;
  const channel = isInteraction ? interactionOrMessage.channel : interactionOrMessage.channel;

  let weaponQuery = isInteraction ? interactionOrMessage.options.getString("weapon") : null;
  let cardQuery = isInteraction ? interactionOrMessage.options.getString("card") : null;

  if (!isInteraction) {
    const parts = interactionOrMessage.content.trim().split(/\s+/);
    parts.splice(0, 2); // remove prefix and command
    if (parts.length === 1) {
      // could be either weapon name or card name — try card first
      cardQuery = parts[0];
    } else if (parts.length >= 2) {
      weaponQuery = parts[0];
      cardQuery = parts.slice(1).join(" ");
    }
  }

  if (!weaponQuery && !cardQuery) {
    const reply = "Usage: `op unequip <weapon|card>` — provide a weapon name or the card to unequip from.";
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true }); else await channel.send(reply);
    return;
  }

  const weaponInv = await WeaponInventory.findOne({ userId });
  if (!weaponInv) {
    const reply = "You don't have any weapons crafted.";
    if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true }); else await channel.send(reply);
    return;
  }

  // If card provided, find any weapon equipped to that card and unequip
  if (cardQuery) {
    const card = getCardByQuery(cardQuery);
    if (!card) {
      const reply = `No card matching "${cardQuery}" found.`;
      if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true }); else await channel.send(reply);
      return;
    }

    // find weapon in inventory equipped to this card
    let foundId = null;
    if (weaponInv.weapons instanceof Map) {
      for (const [wid, wobj] of weaponInv.weapons.entries()) {
        if (wobj && wobj.equippedTo === card.id) { foundId = wid; break; }
      }
    } else {
      for (const wid of Object.keys(weaponInv.weapons || {})) {
        const wobj = weaponInv.weapons[wid];
        if (wobj && wobj.equippedTo === card.id) { foundId = wid; break; }
      }
    }

    if (!foundId) {
      const reply = `${card.name} has no weapon equipped.`;
      if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true }); else await channel.send(reply);
      return;
    }

    if (weaponInv.weapons instanceof Map) {
      const wobj = weaponInv.weapons.get(foundId);
      wobj.equippedTo = null;
      weaponInv.weapons.set(foundId, wobj);
    } else {
      weaponInv.weapons[foundId].equippedTo = null;
    }

    await weaponInv.save();
    const reply = `Unequipped weapon from ${card.name}.`;
    if (isInteraction) await interactionOrMessage.reply({ content: reply }); else await channel.send(reply);
    return;
  }

  // If weapon provided, unequip that specific weapon
  if (weaponQuery) {
    const weapon = getWeaponById(weaponQuery);
    if (!weapon) {
      const reply = `Weapon ${weaponQuery} not found.`;
      if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true }); else await channel.send(reply);
      return;
    }

    const userWeapon = weaponInv.weapons instanceof Map ? weaponInv.weapons.get(weapon.id) : weaponInv.weapons?.[weapon.id];
    if (!userWeapon) {
      const reply = `You don't own ${weapon.name}.`;
      if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true }); else await channel.send(reply);
      return;
    }

    if (!userWeapon.equippedTo) {
      const reply = `${weapon.name} is not equipped.`;
      if (isInteraction) await interactionOrMessage.reply({ content: reply, ephemeral: true }); else await channel.send(reply);
      return;
    }

    if (weaponInv.weapons instanceof Map) {
      userWeapon.equippedTo = null;
      weaponInv.weapons.set(weapon.id, userWeapon);
    } else {
      weaponInv.weapons[weapon.id].equippedTo = null;
    }

    await weaponInv.save();
    const reply = `Unequipped ${weapon.name}.`;
    if (isInteraction) await interactionOrMessage.reply({ content: reply }); else await channel.send(reply);
    return;
  }
}

export const description = "Unequip a weapon from a card";
