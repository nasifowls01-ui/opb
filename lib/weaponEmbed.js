import { EmbedBuilder } from "discord.js";
import { getRankInfo, getCardById, cards } from "../cards.js";

export function buildWeaponBlueprintEmbed(weapon, viewer) {
  // Show weapon blueprint embed
  const rankInfo = getRankInfo(weapon.rank);
  
  const statsParts = [];
  
  if (weapon.boost) {
    const boosts = [];
    if (weapon.boost.atk > 0) boosts.push(`+${weapon.boost.atk} ATK`);
    if (weapon.boost.spd > 0) boosts.push(`+${weapon.boost.spd} SPD`);
    if (weapon.boost.hp > 0) boosts.push(`+${weapon.boost.hp} HP`);
    if (boosts.length > 0) {
      statsParts.push(`**Boost:** ${boosts.join(", ")}`);
    }
  }
  
  if (weapon.type) {
    statsParts.push(`**Type:** ${weapon.type}`);
  }
  
  if (weapon.craftingRequirements && weapon.craftingRequirements.materials) {
    const mats = Object.entries(weapon.craftingRequirements.materials)
      .map(([mat, count]) => `${count} ${mat}`)
      .join(", ");
    statsParts.push(`**Materials Needed:** ${mats}`);
  }

  const statsText = statsParts.join("\n");

  const descParts = [];
  descParts.push("*Blueprint*");
  descParts.push("");
  descParts.push(statsText);

  const embed = new EmbedBuilder()
    .setTitle(`${weapon.name} Blueprint`)
    .setColor(rankInfo?.color || 0x808080)
    .setDescription(descParts.join("\n"));

  if (weapon.image) embed.setImage(weapon.image);
  if (rankInfo?.icon) embed.setThumbnail(rankInfo.icon);

  const footerText = `blueprint • Pity: -/100`;
  if (viewer && typeof viewer.displayAvatarURL === 'function') embed.setFooter({ text: footerText, iconURL: viewer.displayAvatarURL() });
  else embed.setFooter({ text: footerText });

  return embed;
}

export function buildWeaponEmbed(weapon, viewer) {
  // Show base weapon info (not crafted yet)
  const rankInfo = getRankInfo(weapon.rank);
  
  const statsParts = [];
  
  // Build boost string (show positive boosts in slash-separated order ATK/SPD/HP)
  const boostPieces = [];
  if (weapon.boost) {
    boostPieces.push(weapon.boost.atk ? `+${weapon.boost.atk} ATK` : null);
    boostPieces.push(weapon.boost.spd ? `+${weapon.boost.spd} SPD` : null);
    boostPieces.push(weapon.boost.hp ? `+${weapon.boost.hp} HP` : null);
  }
  const boostText = boostPieces.filter(Boolean).join(" / ") || "";

  // Signature cards: show full variants (all ranks) by matching names
  let sigText = "";
  if (weapon.signatureCards && weapon.signatureCards.length > 0) {
    const sigNames = [];
    const seen = new Set();
    const allCards = (global?.cards || cards || []);
    for (const cardId of weapon.signatureCards) {
      const baseCard = getCardById(cardId);
      if (!baseCard) continue;
      const baseNameKey = (baseCard.name || "").toLowerCase();
      if (seen.has(baseNameKey)) continue; // avoid duplicates for same character
      seen.add(baseNameKey);
      const variants = allCards.filter(c => (c.name || "").toLowerCase() === baseNameKey);
      if (variants.length > 0) {
        const parts = variants.map(v => `${v.name} ${v.rank || ""}`.trim());
        sigNames.push(parts.join(" / "));
      } else {
        sigNames.push(baseCard.name);
      }
    }
    sigText = sigNames.join(", ");
  }

  // Arrange fields: Type, Boost, Signature Cards
  if (boostText) statsParts.push(`**Boost:** ${boostText}`);
  if (weapon.type) statsParts.push(`**Type:** ${weapon.type}`);
  if (sigText) statsParts.push(`**Signature Cards:** ${sigText}`);

  const statsText = statsParts.join("\n");

  const descParts = [];
  descParts.push(weapon.title || "");
  descParts.push("");
  descParts.push(statsText);

  const embed = new EmbedBuilder()
    .setTitle(weapon.name)
    .setColor(rankInfo?.color || 0x808080)
    .setDescription(descParts.join("\n"));

  if (weapon.image) embed.setImage(weapon.image);
  if (rankInfo?.icon) embed.setThumbnail(rankInfo.icon);

  const footerText = weapon.name;
  if (viewer && typeof viewer.displayAvatarURL === 'function') embed.setFooter({ text: footerText, iconURL: viewer.displayAvatarURL() });
  else embed.setFooter({ text: footerText });

  return embed;
}

export function buildUserWeaponEmbed(weapon, userWeapon, viewer, isSignatureBoosted = false) {
  // Show user's crafted weapon with level
  if (!userWeapon) {
    return null;
  }

  const rankInfo = getRankInfo(weapon.rank);
  const weaponLevel = userWeapon.level || 1;
  
  const statsParts = [];
  
  // Order: Level, Boost, Type, Source, Signature cards, Wielder
  if (weaponLevel >= 1) {
    statsParts.push(`**Level:** ${weaponLevel} (${userWeapon.xp || 0}/100)`);
  }

  // Boost calculation: base boost + (level - 1) % boost
  // Plus 25% if this is a signature weapon equipped to its card
  const boostPieces = [];
  if (weapon.boost) {
    const levelBoost = (weaponLevel - 1) * 0.01;
    const sigBoost = isSignatureBoosted ? 0.25 : 0;
    const totalBoost = levelBoost + sigBoost;
    
    const atkBoosted = Math.round(weapon.boost.atk * (1 + totalBoost));
    const spdBoosted = Math.round(weapon.boost.spd * (1 + totalBoost));
    const hpBoosted = Math.round(weapon.boost.hp * (1 + totalBoost));
    
    if (atkBoosted > 0) boostPieces.push(`+${atkBoosted} ATK`);
    if (spdBoosted > 0) boostPieces.push(`+${spdBoosted} SPD`);
    if (hpBoosted > 0) boostPieces.push(`+${hpBoosted} HP`);
    
    if (isSignatureBoosted) boostPieces.push('(+25% signature boost)');
  }
  const boostText = boostPieces.filter(Boolean).join(" / ") || "";
  if (boostText) statsParts.push(`**Boost:** ${boostText}`);

  if (weapon.type) {
    statsParts.push(`**Type:** ${weapon.type}`);
  }

  statsParts.push(`**Source:** Card Pulls`);

  // Signature cards: include all ranks/variants by name and rank
  if (weapon.signatureCards && weapon.signatureCards.length > 0) {
    const sigNames = [];
    const seen = new Set();
    const allCards = (global?.cards || cards || []);
    for (const cardId of weapon.signatureCards) {
      const baseCard = getCardById(cardId);
      if (!baseCard) continue;
      const baseNameKey = (baseCard.name || "").toLowerCase();
      if (seen.has(baseNameKey)) continue;
      seen.add(baseNameKey);
      const variants = allCards.filter(c => (c.name || "").toLowerCase() === baseNameKey);
      if (variants.length > 0) {
        const parts = variants.map(v => `${v.name} ${v.rank || ""}`.trim());
        sigNames.push(parts.join(" / "));
      } else {
        sigNames.push(baseCard.name);
      }
    }
    statsParts.push(`**Signature Cards:** ${sigNames.join(", ")}`);
  }
  
  if (userWeapon.equippedTo) {
    const equippedCard = getCardById(userWeapon.equippedTo);
    statsParts.push(`**Wielder:** ${equippedCard ? equippedCard.name : userWeapon.equippedTo}`);
  }

  const statsText = statsParts.join("\n");

  const descParts = [];
  descParts.push(weapon.title || "");
  descParts.push("");
  descParts.push(statsText);

  const embed = new EmbedBuilder()
    .setTitle(weapon.name)
    .setColor(rankInfo?.color || 0x808080)
    .setDescription(descParts.join("\n"));

  if (weapon.image) embed.setImage(weapon.image);
  if (rankInfo?.icon) embed.setThumbnail(rankInfo.icon);

  const footerText = weapon.name;
  if (viewer && typeof viewer.displayAvatarURL === 'function') embed.setFooter({ text: footerText, iconURL: viewer.displayAvatarURL() });
  else embed.setFooter({ text: footerText });

  return embed;
}
