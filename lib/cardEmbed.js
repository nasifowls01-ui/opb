import { EmbedBuilder } from "discord.js";
import { getRankInfo, getCardById } from "../cards.js";
import { cards } from "../cards.js";
import { buildWeaponEmbed } from "./weaponEmbed.js";

export function fuzzyFindCard(query) {
  if (!query) return null;
  const q = String(query).toLowerCase();
  let card = cards.find((c) => c.id.toLowerCase() === q);
  if (card) return card;
  card = cards.find((c) => c.name.toLowerCase() === q);
  if (card) return card;
  card = cards.find((c) => c.name.toLowerCase().startsWith(q));
  if (card) return card;
  card = cards.find((c) => c.name.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
  return card || null;
}

export function buildCardEmbed(card, ownedEntry, viewer) {
  // If this card is a weapon, delegate to weapon embed
  if (card && card.type && String(card.type).toLowerCase() === "weapon") {
    return buildWeaponEmbed(card, viewer);
  }
  // Show base card stats (no level multipliers)
  const basePower = Math.round(card.power || 0);
  const baseAttackMin = Math.round((card.attackRange?.[0] || 0));
  const baseAttackMax = Math.round((card.attackRange?.[1] || 0));
  const baseHealth = Math.round(card.health || 0);

  const rankInfo = getRankInfo(card.rank);

  // Build stats parts, only include non-empty fields
  const statsParts = [];
  
  if (basePower > 0) {
    statsParts.push(`**Power:** ${basePower}`);
  }
  
  if (baseAttackMin > 0 || baseAttackMax > 0) {
    statsParts.push(`**Attack:** ${baseAttackMin} - ${baseAttackMax}`);
  }
  
  if (baseHealth > 0) {
    statsParts.push(`**Health:** ${baseHealth}`);
  }
  
  if (card.ability) {
    statsParts.push(`**Effect:** ${card.ability}`);
  }
  
  if (card.type) {
    statsParts.push(`**Type:** ${card.type}`);
  }
  
  if (card.specialAttack) {
    statsParts.push(`**Special:** ${card.specialAttack.name} (${card.specialAttack.range[0]}-${card.specialAttack.range[1]} damage)`);
  }

  // Add signature weapon field if card has one
  if (card.signatureWeapon) {
    const sigWeapon = getCardById(card.signatureWeapon);
    if (sigWeapon) {
      statsParts.push(`**Signature Weapon:** ${sigWeapon.name}`);
    }
  }

  // Check for weapons field
  if (card.weapons && card.weapons.length > 0) {
    statsParts.push(`**Weapons:** ${card.weapons.join(", ")}`);
  }

  const statsText = statsParts.join("\n");

  // 'Owned' text only for base stats
  const owned = !!(ownedEntry && (ownedEntry.count || 0) > 0);
  const ownedText = `Owned: ${owned ? 'Yes' : 'No'}`;

  const descParts = [];
  if (card.title) descParts.push(card.title);
  descParts.push(ownedText);
  descParts.push("");
  descParts.push(statsText);

  const embed = new EmbedBuilder()
    .setTitle(card.name)
    .setColor(rankInfo?.color || 0x808080)
    .setDescription(descParts.join("\n"));

  if (card.image) embed.setImage(card.image);
  if (rankInfo?.icon) embed.setThumbnail(rankInfo.icon);

  // Determine upgrade position among same-name cards
  const same = cards.filter(c => (c.name || "").toLowerCase() === (card.name || "").toLowerCase());
  let footerText = card.name;
  if (same.length > 1) {
    // try to sort by rank value if available
    const sorted = same.slice().sort((a,b) => {
      const va = getRankInfo(a.rank)?.value || 0;
      const vb = getRankInfo(b.rank)?.value || 0;
      return va - vb;
    });
    const idx = sorted.findIndex(c => c.id === card.id);
    if (idx !== -1) footerText = `${card.name} • Upgrade ${idx+1}/${sorted.length}`;
  }

  if (viewer && typeof viewer.displayAvatarURL === 'function') embed.setFooter({ text: footerText, iconURL: viewer.displayAvatarURL() });
  else embed.setFooter({ text: footerText });

  return embed;
}

export function buildUserCardEmbed(card, ownedEntry, viewer, equippedWeapon = null) {
  // Show card stats with user's level multipliers
  if (!ownedEntry || (ownedEntry.count || 0) <= 0) {
    return null; // User doesn't own this card
  }

  // For weapons, the user-owned view is handled separately via WeaponInventory
  if (card && card.type && String(card.type).toLowerCase() === "weapon") {
    return null;
  }

  const userLevel = ownedEntry.level || 0;
  const rankInfo = getRankInfo(card.rank);
  
  // Calculate stats with level multiplier (1% per level)
  const levelMultiplier = 1 + (userLevel * 0.01);
  let basePower = (card.power || 0) * levelMultiplier;
  let baseAttackMin = (card.attackRange?.[0] || 0) * levelMultiplier;
  let baseAttackMax = (card.attackRange?.[1] || 0) * levelMultiplier;
  let baseHealth = (card.health || 0) * levelMultiplier;
  
  // Apply weapon boosts if equipped signature weapon
  let weaponBoostText = "";
  if (equippedWeapon && equippedWeapon.card && card.signatureWeapon === equippedWeapon.id) {
    const weaponCard = equippedWeapon.card;
    const weaponLevel = equippedWeapon.level || 1;
    const weaponLevelBoost = (weaponLevel - 1) * 0.01;
    const sigBoost = 0.25; // Always 25% for signature
    const totalWeaponBoost = 1 + weaponLevelBoost + sigBoost;
    
    if (weaponCard.boost) {
      basePower += Math.round((weaponCard.boost.atk || 0) * totalWeaponBoost);
      baseAttackMin += Math.round((weaponCard.boost.atk || 0) * totalWeaponBoost);
      baseAttackMax += Math.round((weaponCard.boost.atk || 0) * totalWeaponBoost);
      baseHealth += Math.round((weaponCard.boost.hp || 0) * totalWeaponBoost);
      
      const boostPieces = [];
      if (weaponCard.boost.atk > 0) boostPieces.push(`+${Math.round((weaponCard.boost.atk || 0) * totalWeaponBoost)} ATK`);
      if (weaponCard.boost.hp > 0) boostPieces.push(`+${Math.round((weaponCard.boost.hp || 0) * totalWeaponBoost)} HP`);
      if (boostPieces.length > 0) weaponBoostText = ` (${boostPieces.join(" / ")} from weapon)`;
    }
  }
  
  const userPower = Math.round(basePower);
  const userAttackMin = Math.round(baseAttackMin);
  const userAttackMax = Math.round(baseAttackMax);
  const userHealth = Math.round(baseHealth);

  // Build stats parts, only include non-empty fields
  const statsParts = [];
  
  if (userLevel >= 0) {
    // Display level and current XP out of required XP for next level
    const currentXP = ownedEntry.xp || 0;
    const requiredXP = (userLevel + 1) * 100;
    statsParts.push(`**Level:** ${userLevel} (${currentXP}/${requiredXP})`);
  }
  
  if (userPower > 0) {
    statsParts.push(`**Power:** ${userPower}`);
  }
  
  if (userAttackMin > 0 || userAttackMax > 0) {
    let attackText = `**Attack:** ${userAttackMin} - ${userAttackMax}`;
    if (equippedWeapon && equippedWeapon.card && card.signatureWeapon === equippedWeapon.id && equippedWeapon.card.boost?.atk > 0) {
      const weaponCard = equippedWeapon.card;
      const weaponLevel = equippedWeapon.level || 1;
      const weaponLevelBoost = (weaponLevel - 1) * 0.01;
      const sigBoost = 0.25;
      const totalWeaponBoost = 1 + weaponLevelBoost + sigBoost;
      const boostAmount = Math.round((weaponCard.boost.atk || 0) * totalWeaponBoost);
      attackText += ` (+${boostAmount})`;
    }
    statsParts.push(attackText);
  }
  
  if (userHealth > 0) {
    let healthText = `**Health:** ${userHealth}`;
    if (equippedWeapon && equippedWeapon.card && card.signatureWeapon === equippedWeapon.id && equippedWeapon.card.boost?.hp > 0) {
      const weaponCard = equippedWeapon.card;
      const weaponLevel = equippedWeapon.level || 1;
      const weaponLevelBoost = (weaponLevel - 1) * 0.01;
      const sigBoost = 0.25;
      const totalWeaponBoost = 1 + weaponLevelBoost + sigBoost;
      const boostAmount = Math.round((weaponCard.boost.hp || 0) * totalWeaponBoost);
      healthText += ` (+${boostAmount})`;
    }
    statsParts.push(healthText);
  }
  
  if (card.ability) {
    statsParts.push(`**Effect:** ${card.ability}`);
  }
  
  if (card.type) {
    statsParts.push(`**Type:** ${card.type}`);
  }
  
  if (card.specialAttack) {
    statsParts.push(`**Special:** ${card.specialAttack.name} (${card.specialAttack.range[0]}-${card.specialAttack.range[1]} damage)`);
  }

  // Add signature weapon field if card has one
  if (card.signatureWeapon) {
    const sigWeapon = getCardById(card.signatureWeapon);
    if (sigWeapon) {
      statsParts.push(`**Signature Weapon:** ${sigWeapon.name}`);
    }
  }

  // Show equipped weapon if one is passed
  if (equippedWeapon) {
    const weaponName = equippedWeapon.card ? equippedWeapon.card.name : equippedWeapon.name || "Unknown";
    const isSignature = card.signatureWeapon === equippedWeapon.id || (equippedWeapon.card && card.signatureWeapon === equippedWeapon.card.id);
    const sigMark = isSignature ? " (Signature)" : "";
    statsParts.push(`**Equipped Weapon:** ${weaponName}${sigMark}`);
  }

  // Check for weapons field
  if (card.weapons && card.weapons.length > 0) {
    statsParts.push(`**Weapons:** ${card.weapons.join(", ")}`);
  }

  const statsText = statsParts.join("\n");

  // 'Obtained from' should be in user stats
  const obtained = card.source || "Card Pulls";

  const descParts = [];
  if (card.title) descParts.push(card.title);
  descParts.push(`Obtained from: ${obtained}`);
  descParts.push("");
  descParts.push(statsText);

  const embed = new EmbedBuilder()
    .setTitle(card.name)
    .setColor(rankInfo?.color || 0x808080)
    .setDescription(descParts.join("\n"));

  if (card.image) embed.setImage(card.image);
  if (rankInfo?.icon) embed.setThumbnail(rankInfo.icon);

  // Determine upgrade position among same-name cards
  const same = cards.filter(c => (c.name || "").toLowerCase() === (card.name || "").toLowerCase());
  let footerText = card.name;
  if (same.length > 1) {
    const sorted = same.slice().sort((a,b) => {
      const va = getRankInfo(a.rank)?.value || 0;
      const vb = getRankInfo(b.rank)?.value || 0;
      return va - vb;
    });
    const idx = sorted.findIndex(c => c.id === card.id);
    if (idx !== -1) footerText = `${card.name} • Upgrade ${idx+1}/${sorted.length}`;
  }

  if (viewer && typeof viewer.displayAvatarURL === 'function') embed.setFooter({ text: footerText, iconURL: viewer.displayAvatarURL() });
  else embed.setFooter({ text: footerText });

  return embed;
}
