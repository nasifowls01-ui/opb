function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickWeighted(list) {
  const total = list.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const x of list) {
    if (r < x.weight) return x.item;
    r -= x.weight;
  }
  return null;
}

const HEALING = [
  { item: 'meat', weight: 30 },
  { item: 'fish', weight: 30 },
  { item: 'sake', weight: 20 },
  { item: 'bento box', weight: 5 },
  { item: 'milk', weight: 10 },
  { item: 'sea king meat', weight: 5 }
];

const MATERIALS = [
  { item: 'Steel', weight: 10 },
  { item: 'Iron', weight: 10 },
  { item: 'Wood', weight: 10 },
  { item: 'Leather', weight: 10 },
  { item: 'Ray Skin', weight: 10 },
  { item: 'Titanium', weight: 10 },
  { item: 'Obsidian', weight: 10 },
  { item: 'Spring', weight: 10 },
  { item: 'Aluminum', weight: 10 },
  { item: 'Brass', weight: 10 }
];

const LEGENDARIES = [
  { item: 'log pose', weight: 15 },
  { item: 'map', weight: 15 },
  { item: 'gold bar', weight: 15 },
  { item: 'jolly roger flag', weight: 15 },
  { item: 'crew contract', weight: 10 },
  { item: 'ancient relic', weight: 10 },
  { item: 'S rank summon', weight: 10 },
  { item: 'awakening', weight: 10 }
];

export function getChestRewards(rank, inventoryItems) {
  const rewards = {
    yen: 0,
    xpScrolls: 0,
    xpBooks: 0,
    battleTokens: 0,
    healing: {},
    materials: {},
    resetTokens: 0,
    legendaries: []
  };

  const r = (rank || '').toUpperCase();
  if (r === 'C') {
    rewards.yen = randInt(50, 100);
    if (Math.random() < 0.30) rewards.xpScrolls += randInt(1, 2);
    if (Math.random() < 0.30) rewards.battleTokens += randInt(1, 2);
    if (Math.random() < 0.10) {
      const h = pickWeighted(HEALING);
      rewards.healing[h] = (rewards.healing[h] || 0) + 1;
    }
    if (Math.random() < 0.10) {
      const m = pickWeighted(MATERIALS);
      rewards.materials[m] = (rewards.materials[m] || 0) + 1;
    }
    if (Math.random() < 0.05) rewards.resetTokens += 1;
  } else if (r === 'B') {
    rewards.yen = randInt(100, 250);
    rewards.xpScrolls += randInt(1, 2);
    // nerfed xp book chance by 50% (was 0.5)
    if (Math.random() < 0.25) rewards.xpBooks += 1;
    rewards.battleTokens += randInt(1, 2);
    if (Math.random() < 0.30) {
      const h = pickWeighted(HEALING);
      rewards.healing[h] = (rewards.healing[h] || 0) + 1;
    }
    if (Math.random() < 0.30) {
      const m = pickWeighted(MATERIALS);
      rewards.materials[m] = (rewards.materials[m] || 0) + 1;
    }
    if (Math.random() < 0.25) rewards.resetTokens += 1;
  } else if (r === 'A') {
    rewards.yen = randInt(250, 500);
    rewards.xpScrolls += randInt(2, 5);
    // nerfed xp book drops by 50% (was guaranteed +1)
    if (Math.random() < 0.5) rewards.xpBooks += 1;
    rewards.battleTokens += randInt(2, 5);
    const healCount = randInt(1, 2);
    for (let i = 0; i < healCount; i++) {
      const h = pickWeighted(HEALING);
      rewards.healing[h] = (rewards.healing[h] || 0) + 1;
    }
    const matCount = randInt(1, 2);
    for (let i = 0; i < matCount; i++) {
      const m = pickWeighted(MATERIALS);
      rewards.materials[m] = (rewards.materials[m] || 0) + 1;
    }
    rewards.resetTokens += randInt(1, 2);
    if (Math.random() < 0.10) {
      const leg = pickWeighted(LEGENDARIES);
      rewards.legendaries.push(leg);
    }
  } else if (r === 'S') {
    rewards.yen = randInt(500, 2500);
    rewards.xpScrolls += randInt(5, 10);
    // nerfed xp book quantity by 50% expected (only give books half the time)
    if (Math.random() < 0.5) rewards.xpBooks += randInt(1, 2);
    rewards.battleTokens += randInt(5, 10);
    const healCountS = randInt(2, 5);
    for (let i = 0; i < healCountS; i++) {
      const h = pickWeighted(HEALING);
      rewards.healing[h] = (rewards.healing[h] || 0) + 1;
    }
    const matCountS = randInt(2, 5);
    for (let i = 0; i < matCountS; i++) {
      const m = pickWeighted(MATERIALS);
      rewards.materials[m] = (rewards.materials[m] || 0) + 1;
    }
    rewards.resetTokens += randInt(2, 5);
    if (Math.random() < 0.25) {
      const leg = pickWeighted(LEGENDARIES);
      rewards.legendaries.push(leg);
    }
  } else {
    throw new Error('Invalid chest rank');
  }

  return rewards;
}

export const RANKS = ['C', 'B', 'A', 'S'];