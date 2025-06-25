const pokeApiBase = 'https://pokeapi.co/api/v2';



const genToVersionGroups = {
  1: ['red-blue', 'yellow'],
  2: ['gold-silver', 'crystal'],
  3: ['ruby-sapphire', 'emerald', 'fire-red-leaf-green'],
  4: ['diamond-pearl', 'platinum', 'heartgold-soulsilver'],
  5: ['black-white', 'black-2-white-2'],
  6: ['x-y', 'omega-ruby-alpha-sapphire'],
  7: ['sun-moon', 'ultra-sun-ultra-moon'],
  8: ['sword-shield'],
  9: ['scarlet-violet']
};


async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getGenerationPokemon(gen) {
  const data = await fetchJson(`${pokeApiBase}/generation/${gen}`);
  return data.pokemon_species.map(species => ({
    name: species.name,
    url: species.url,
  }));
}



function pickRandom(arr, n) {
  const result = [];
  const copy = [...arr];
  const limit = Math.min(n, copy.length);
  for (let i = 0; i < limit; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return result;
}

async function getPokemonData(name, gen) {
  try {
    const data = await fetchJson(`${pokeApiBase}/pokemon/${name}`);
    
    const allowedVersionGroups = genToVersionGroups[gen] || [];

    // Filter moves to only those available in allowed version groups
    const filteredMoves = data.moves.filter(moveEntry => {
      // moveEntry.version_group_details is an array describing which version groups this move is learnable in
      return moveEntry.version_group_details.some(vgd =>
        allowedVersionGroups.includes(vgd.version_group.name)
      );
    }).map(m => m.move.name);

    // For abilities, filtering by gen introduced is still okay:
    const filteredAbilities = [];
    for (const abilityEntry of data.abilities) {
      const abilityGen = await getAbilityGen(abilityEntry.ability.name);
      if (abilityGen <= gen) filteredAbilities.push(abilityEntry.ability.name);
    }

    return {
      name: data.name,
      moves: filteredMoves,
      abilities: filteredAbilities,
    };
  } catch (err) {
    console.warn(`Failed to fetch data for ${name}: ${err.message}`);
    return null;
  }
}

function getFinalEvolutions(chain) {
  // Recursive function to find all final species names in the evolution chain
  if (!chain.evolves_to || chain.evolves_to.length === 0) {
    return [chain.species.name];
  }
  let finals = [];
  for (const evo of chain.evolves_to) {
    finals = finals.concat(getFinalEvolutions(evo));
  }
  return finals;
}


async function fetchEvolutionChains(speciesList) {
  // Map from evo chain url to array of species names that are final evolutions
  const evoChainMap = new Map();

  // Get all unique evolution_chain urls
  const evoUrls = new Set();
  const speciesToEvoUrl = {};

  // Fetch species data in parallel
  const speciesDataArr = await Promise.all(
    speciesList.map(s => fetchJson(`${pokeApiBase}/pokemon-species/${s.name}`))
  );

  speciesDataArr.forEach(speciesData => {
    const evoUrl = speciesData.evolution_chain.url;
    evoUrls.add(evoUrl);
    speciesToEvoUrl[speciesData.name] = evoUrl;
  });

  // Fetch all evolution chains in parallel
  const evoChains = await Promise.all(
    [...evoUrls].map(url => fetchJson(url))
  );

  // Parse all final evolutions
  evoChains.forEach((chainData, i) => {
    const url = [...evoUrls][i];
    const finals = getFinalEvolutions(chainData.chain);
    evoChainMap.set(url, finals);
  });

  // Return a map: species name => boolean if fully evolved
  const evoInfoMap = {}; // { speciesName: { isFinal: bool, hasEvolutions: bool } }

  for (const s of speciesList) {
    const evoUrl = speciesToEvoUrl[s.name];
    const finalForms = evoChainMap.get(evoUrl);
    const isFinal = finalForms.includes(s.name);
    const hasEvolutions = finalForms.length > 0 && !isFinal;
    evoInfoMap[s.name] = {
      isFinal,
      hasEvolutions
  };
}

  return evoInfoMap;
}

// Modified generateTeam to use this:

async function generateTeam(gen, onlyFullyEvolved, randomizeEVs, randomizeItems) {
  let speciesList = await getGenerationPokemon(gen);

  let evoInfoMap = null;
  if (onlyFullyEvolved || randomizeItems) {
    // Need this map for item legality too
    evoInfoMap = await fetchEvolutionChains(speciesList);
    if (onlyFullyEvolved) {
      speciesList = speciesList.filter(s => evoInfoMap[s.name]?.isFinal);
    }
  }

  speciesList = speciesList.sort(() => Math.random() - 0.5);

  const sampleSize = Math.min(speciesList.length, 40);
  const sample = speciesList.slice(0, sampleSize);

  const batchSize = 10;
  let team = [];
  for (let i = 0; i < sample.length && team.length < 6; i += batchSize) {
    const batch = sample.slice(i, i + batchSize);
    const datas = await Promise.all(batch.map(s => getPokemonData(s.name, gen)));
    for (const data of datas) {
      if (!data) continue;
      const moves = pickRandom(data.moves, 4);
      const ability = gen >= 3 && data.abilities.length > 0
        ? pickRandom(data.abilities, 1)[0]
        : '';
      const speciesName = data.name.toLowerCase();
      const evoInfo = evoInfoMap ? evoInfoMap[speciesName] : { isFinal: false, hasEvolutions: true };
      const isFullyEvolved = evoInfo.isFinal;
      const canEvolve = evoInfo.hasEvolutions;
      const item = randomizeItems ? randomItem(isFullyEvolved, canEvolve, gen) : '[Item]';




      team.push({
        name: capitalize(data.name),
        moves,
        ability,
        evs: randomizeEVs ? randomEVSpread() : '252 Atk / 252 Spe / 4 HP',
        nature: randomizeEVs ? randomNature() : 'Adamant',
        item
      });

      if (team.length >= 6) break;
    }
  }

  if (team.length < 6) {
    throw new Error('Not enough Pokémon to generate a full team');
  }

  return team;
}




function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const genCache = {
  moves: new Map(),     // moveName -> genNumber
  abilities: new Map(), // abilityName -> genNumber
};

async function getMoveGen(moveName) {
  if (genCache.moves.has(moveName)) return genCache.moves.get(moveName);
  const data = await fetchJson(`${pokeApiBase}/move/${moveName}`);
  // The generation URL is like "/api/v2/generation/3/"
  const genUrl = data.generation.url;
  const genNum = parseInt(genUrl.match(/generation\/(\d+)\//)[1]);
  genCache.moves.set(moveName, genNum);
  return genNum;
}

async function getAbilityGen(abilityName) {
  if (genCache.abilities.has(abilityName)) return genCache.abilities.get(abilityName);
  const data = await fetchJson(`${pokeApiBase}/ability/${abilityName}`);
  const genUrl = data.generation.url;
  const genNum = parseInt(genUrl.match(/generation\/(\d+)\//)[1]);
  genCache.abilities.set(abilityName, genNum);
  return genNum;
}

async function filterMovesAbilitiesByGen(moves, abilities, gen) {
  // Filter moves
  const filteredMoves = [];
  for (const moveName of moves) {
    const moveGen = await getMoveGen(moveName);
    if (moveGen <= gen) filteredMoves.push(moveName);
  }
  
  // Filter abilities
  const filteredAbilities = [];
  for (const abilityName of abilities) {
    const abilityGen = await getAbilityGen(abilityName);
    if (abilityGen <= gen) filteredAbilities.push(abilityName);
  }
  
  return { moves: filteredMoves, abilities: filteredAbilities };
}



function randomEVSpread() {
  const stats = ['HP', 'Atk', 'Def', 'SpA', 'SpD', 'Spe'];
  const evs = {};
  let remaining = 508;

  stats.forEach(stat => evs[stat] = 0);

  while (remaining > 0) {
    const stat = stats[Math.floor(Math.random() * stats.length)];
    const add = Math.min(remaining, Math.floor(Math.random() * 64));
    if (evs[stat] + add <= 252) {
      evs[stat] += add;
      remaining -= add;
    }
  }

  return stats.filter(s => evs[s] > 0).map(s => `${evs[s]} ${s}`).join(' / ');
}

function randomNature() {
  const natures = [
    'Adamant', 'Modest', 'Jolly', 'Timid', 'Brave', 'Calm', 'Impish', 'Bold',
    'Careful', 'Hardy', 'Hasty', 'Lonely', 'Mild', 'Naive', 'Quiet', 'Rash',
    'Relaxed', 'Sassy', 'Serious', 'Docile', 'Lax', 'Gentle', 'Bashful', 'Quirky', 'Naughty'
  ];
  return natures[Math.floor(Math.random() * natures.length)];
}

function getItemPoolForGen(gen) {
  return itemPoolByGen[gen] || [];
}

function randomItem(isFullyEvolved, canEvolve, gen) {
  console.log('Random Item Gen:', gen);
  let items = getItemPoolForGen(gen);

  if (!(canEvolve && !isFullyEvolved)) {
    items = items.filter(i => i !== 'Eviolite');
  }
  return items[Math.floor(Math.random() * items.length)];
}




function showdownFormat(team) {
  return team.map(poke => {
    return `${poke.name} @ ${poke.item}
Ability: ${capitalize(poke.ability)}
Level: 100
EVs: ${poke.evs}
Nature: ${poke.nature}
- ${poke.moves.map(capitalize).join('\n- ')}`;
  }).join('\n\n');
}


const output = document.getElementById('output');
const generateBtn = document.getElementById('generateBtn');
const exportBtn = document.getElementById('exportBtn');

let currentTeam = null;

generateBtn.onclick = async () => {
  output.textContent = 'Generating team, please wait...';
  exportBtn.style.display = 'none';
  currentTeam = null;

  const gen = parseInt(document.getElementById('generation').value);
  const onlyFullyEvolved = document.getElementById('fullyEvolved').checked;
  const randomizeEVs = document.getElementById('randomizeEVs').checked;
  const randomizeItems = document.getElementById('randomizeItems').checked;

  try {
    if (gen > 9 || gen < 1) {
      output.textContent = 'Please enter a generation between 1 and 9.'
      return;
    }
    const team = await generateTeam(gen, onlyFullyEvolved, randomizeEVs, randomizeItems);
    if (team.length < 6) {
      output.textContent = 'Could not generate full team (not enough Pokémon matching criteria).';
      return;
    }
    currentTeam = team;
    let displayText = '';
    team.forEach((poke, idx) => {
      displayText += `${idx + 1}. ${poke.name}\nItem: ${poke.item}\nAbility: ${poke.ability}\nEVs: ${poke.evs}\nNature: ${poke.nature}\nMoves: ${poke.moves.join(', ')}\n\n`;
    });

    output.textContent = displayText;
    exportBtn.style.display = 'inline-block';
  } catch (err) {
    output.textContent = 'Error: ' + err.message;
  }
};

exportBtn.onclick = () => {
  if (!currentTeam) return;
  const text = showdownFormat(currentTeam);
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pokemon_team.txt';
  a.click();
  URL.revokeObjectURL(url);
};