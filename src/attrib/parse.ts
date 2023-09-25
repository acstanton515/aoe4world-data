import { ITEM_TYPES } from "../lib/config";
import { getTranslation, NO_TRANSLATION_FOUND } from "./translations";
import { parseXmlFile } from "./xml";
import { parseWeapons } from "./weapons";
import { attribFile, ignoreForNow } from "./config";
import { slugify } from "../lib/utils/string";
import { Armor, Building, Item, ItemClass, ModifyableProperty, Technology, Unit, Upgrade } from "../types/items";
import { civConfig } from "../types/civs";
import { useIcon } from "./icons";
import { technologyModifiers } from "./technologies";
import { RunContext, writeTemp } from "./run";

export async function parseItemFromAttribFile(file: string, data: any, civ: civConfig, context: RunContext) {
  const type = guessType(file, data);
  const { debug, getData } = context;

  if (ignoreForNow.some((i) => (typeof i == "function" ? i(file) : file.includes(i)))) {
    if (debug) console.log(`Ignoring ${file} for now`);
    return undefined;
  }

  if (!type) {
    if (debug) console.log(`Skipping ${file} because it is of an unsupported type`);
    return undefined;
  }

  if (debug) writeTemp(data, file.split("/").join("_"));

  try {
    let ebpextensions = data.extensions;

    const loadout = maybeOnKey(findExt(data, "squadexts", "sbpextensions/squad_loadout_ext")?.unit_list[0], "loadout_data");
    const unitEbps = loadout?.type;
    if (unitEbps) {
      const ebps = await getData(attribFile(unitEbps), undefined, context);
      if (debug) writeTemp(ebps, unitEbps.split("/").join("_"));
      ebpextensions = ebps?.extensions;
    }

    const ebpExts = Object.fromEntries(ebpextensions?.map((e) => [e.exts?.replace("ebpextensions/", ""), e]) ?? []);

    let ui_ext;
    if (type === ITEM_TYPES.BUILDINGS) ui_ext = ebpExts.ui_ext;
    else if (type === ITEM_TYPES.TECHNOLOGIES || type === ITEM_TYPES.UPGRADES) ui_ext = data.upgrade_bag.ui_info;
    else if (type === ITEM_TYPES.UNITS) {
      ui_ext = maybeOnKey(data.extensions.find((e) => e.squadexts === "sbpextensions/squad_ui_ext")?.race_list[0], "race_data")?.info;
    }
    if (!ui_ext && type === ITEM_TYPES.UNITS && ebpExts.ui_ext) ui_ext = ebpExts.ui_ext;

    let name = getTranslation(ui_ext.screen_name);
    if (name === NO_TRANSLATION_FOUND) name = file.split("/").pop()!;
    const description = parseDescription(ui_ext);
    const attribName = file.split("/").pop()!.replace(".xml", "").replace(".json", "");
    const age = parseAge(attribName, ebpExts?.requirement_ext?.requirement_table ?? data.upgrade_bag?.requirements, data.parent_pbg);
    const baseId = getBasedId(name, type, description);
    const id = `${baseId}-${age}`;

    const displayClasses = getTranslation(ui_ext.extra_text)
      .split(",")
      .map((x) => x.trim());

    const classes = displayClasses.flatMap((x) => x.toLowerCase().split(" ")) as ItemClass[];

    const unique = parseUnique(ui_ext);

    const costs = parseCosts(ebpExts?.cost_ext?.time_cost || data.upgrade_bag.time_cost, ebpExts?.population_ext?.personnel_pop);

    const icon = await useIcon(ui_ext.icon_name, type, id);

    const pbgid = data.pbgid;

    let item: Item = {
      id: id,
      baseId,
      type: "unit",
      name,
      pbgid,
      attribName,
      age,
      civs: [civ.abbr],
      description,
      classes,
      displayClasses,
      unique,
      costs,
      producedBy: [],
      icon,
    };

    if (type === ITEM_TYPES.BUILDINGS) {
      let influences = parseInfluences(ui_ext);

      const building: Building = {
        ...item,
        type: "building",
        hitpoints: parseHitpoints(ebpExts?.health_ext),
        weapons: await parseWeapons(ebpExts.combat_ext, context),
        armor: parseArmor(ebpExts?.health_ext),
        sight: parseSight(ebpExts?.sight_ext),
        garrison: parseGarrison(ebpExts?.hold_ext),
        influences,
      } as any;

      return building;
    }

    if (type === ITEM_TYPES.UNITS) {
      const weapons = await parseWeapons(ebpExts.combat_ext, context);

      const loadoutUnits = loadout?.unit_attachments?.map((x) => (x.unit ?? x).type);
      if (loadoutUnits)
        for (const luFile of loadoutUnits) {
          if (ignoreForNow.includes(luFile)) continue;
          try {
            const luEbps = await getData(attribFile(luFile), undefined, context);
            if (debug) writeTemp(luEbps, "ebps_" + luFile.split("/").pop()!);
            const luWeapons = await parseWeapons(
              luEbps?.extensions.find((ex) => ex.exts === "ebpextensions/combat_ext"),
              context
            );
            if (luWeapons) weapons.push(...luWeapons);
          } catch (e) {
            console.log("Error parsing loadout unit", luFile, e);
          }
        }

      const unit: Unit = {
        ...item,
        type: "unit",
        hitpoints: parseHitpoints(ebpExts?.health_ext),
        weapons,
        armor: parseArmor(ebpExts?.health_ext),
        sight: parseSight(ebpExts?.sight_ext),
        movement: parseMovement(ebpExts?.moving_ext),
        garrison: parseGarrison(ebpExts?.hold_ext),
      };

      return unit;
    }

    if (type === ITEM_TYPES.TECHNOLOGIES) {
      const translationParams = ui_ext.help_text_formatter?.formatter_arguments?.map((x) => Object.values(x)[0] ?? x) ?? [];
      const effectsFactory = technologyModifiers[baseId];
      const effects = effectsFactory?.(translationParams) ?? [];

      // if (item.id == "upgrade-militia-4-4") {
      if (effects.length == 0) {
        const addEffect = (property: ModifyableProperty, value: number, effect: "change" | "multiply" = "change", type: "passive" | "ability" = "passive") =>
          effects.push({ property, value, effect, type });

        for (const { id, value } of data?.upgrade_bag?.float_properties ?? []) {
          if (id === "health_max") addEffect("hitpoints", value);
          else if (id === "melee_damage") addEffect("meleeAttack", value);
          else if (id === "charge_damage") addEffect("meleeAttack", value, "change", "ability");
          else if (id === "armor_fire") addEffect("fireArmor", value);
          else if (id === "armor_melee") addEffect("meleeArmor", value);
          else if (id === "armor_range") addEffect("rangedArmor", value);
          else if (id === "damage") {
            addEffect("meleeAttack", value);
            addEffect("rangedAttack", value);
            addEffect("siegeAttack", value);
            addEffect("fireAttack", value);
          } else if (id === "multiplier") {
            // ignore
          } else console.log("Unknown float property", id, value, item.attribName, item.id);
        }
      }
      const tech: Technology = {
        ...item,
        type: "technology",
        effects,
      };

      return tech;
    }

    if (type === ITEM_TYPES.UPGRADES) {
      const upgrade: Upgrade = {
        ...item,
        type: "upgrade",
        unlocks: "",
      };

      return upgrade;
    }
  } catch (e) {
    console.error(`src/attrib/.dev/${file}.essence.json`, e);
    return undefined;
  }
}

function guessType(file: string, data: any) {
  const fileName = file.split("/").pop()!;
  if (fileName.startsWith("building_")) return ITEM_TYPES.BUILDINGS;
  if (fileName.startsWith("unit_")) return ITEM_TYPES.UNITS;
  if (fileName.startsWith("herdable_")) return undefined;
  if (fileName.startsWith("gaia_")) return undefined;
  // below is too hacky for my taste, it filters out some wonky things we would call technologies like wheelbarrow and herbal medicine
  if (fileName.startsWith("upgrade_unit") && data?.upgrade_bag?.global_max_limit == 1) return ITEM_TYPES.UPGRADES;
  if (fileName.startsWith("upgrade_")) return ITEM_TYPES.TECHNOLOGIES;
  return undefined;
}

function getBasedId(name: string, type: ITEM_TYPES, description) {
  let baseId = slugify(name).trim();
  if (type === ITEM_TYPES.UPGRADES && description != NO_TRANSLATION_FOUND) baseId = slugify(description).trim().split("-to-").pop()!;
  if (type == ITEM_TYPES.UNITS) baseId = baseId.replace(/^(early|vanguard|veteran|elite|hardened)\-/, "");
  return baseId;
}

function findExt(data: any, key: string, value: string) {
  return data?.extensions?.find((x) => x[key] === value);
}

function parseDescription(ui_ext: any) {
  const translation = !!ui_ext.help_text_formatter?.formatter
    ? getTranslation(
        ui_ext.help_text_formatter.formatter,
        ui_ext.help_text_formatter.formatter_arguments.map((x) => Object.values(x)[0] ?? x)
      )
    : getTranslation(ui_ext.help_text);
  if (translation === NO_TRANSLATION_FOUND) return `not-found-${Math.random()}`; // throw new Error("No translation found for " + ui_ext.help_text);
  return translation;
}

function parseHitpoints(health_ext: any) {
  return health_ext?.hitpoints;
}

function parseCosts(time_cost: any, popcap = 0) {
  const { food, wood, gold, stone } = time_cost.cost as Record<"food" | "wood" | "gold" | "stone" | "popcap", number>;
  const time = time_cost.time_seconds as number;
  const costs = { food, wood, stone, gold, total: food + wood + gold + stone, popcap, time };
  return costs;
}

function parseAge(name: string, requirements: any, parent_pbg: string) {
  const ageUpLandmark = [
    { parent: "/building_wonder_age3", age: 3 },
    { parent: "/building_wonder_age2", age: 2 },
    { parent: "/building_wonder_age1", age: 1 },
  ];
  const ageup = ageUpLandmark.find((x) => typeof parent_pbg === "string" && parent_pbg?.endsWith(x.parent));
  if (ageup) return ageup.age;
  let age = 1;
  const requiredUpgrade = requirements?.find((x) => String(x?.upgrade_name).endsWith("_age"))?.upgrade_name;
  if (requiredUpgrade?.endsWith("dark_age")) age = 1;
  else if (requiredUpgrade?.endsWith("feudal_age")) age = 2;
  else if (requiredUpgrade?.endsWith("castle_age")) age = 3;
  else if (requiredUpgrade?.endsWith("imperial_age")) age = 4;
  else {
    const nameParts = name!.split("/")!.shift()!.split("_")!;
    for (const p of nameParts.reverse()) {
      const n = parseFloat(p);
      if (!isNaN(n)) {
        age = n;
        break;
      }
    }
  }
  return age;
}

function parseSight(sight_ext: any) {
  return {
    line: sight_ext?.sight_package?.outer_radius || 0,
    height: sight_ext?.sight_package?.inner_height || 0,
  };
}

export const damageMap = {
  "True Damage": "siege",
  Melee: "melee",
  Ranged: "ranged",
  Fire: "fire",
};
const armorSort = ["melee", "ranged", "siege", "fire"];
function parseArmor(health_ext): Armor[] {
  if (!health_ext?.armor_scaler_by_damage_type) return [];
  return (
    Object.entries<number>(health_ext?.armor_scaler_by_damage_type)
      ?.filter(([k, v]) => v > 0)
      .map(([k, v]) => ({ type: damageMap[k], value: v }))
      .sort((a, b) => armorSort.indexOf(a.type) - armorSort.indexOf(b.type)) ?? []
  );
}

function parseMovement(moving_ext: any) {
  return {
    speed: moving_ext?.speed_scaling_table.default_speed / 4,
  };
}

function parseGarrison(hold_ext: any) {
  return hold_ext?.num_slots
    ? {
        capacity: hold_ext?.num_slots,
        classes: hold_ext?.acceptable_types?.map((x) => (typeof x == "string" ? x : x.acceptable_type).replace("hold_", "").replace(/\_/g, " ")) ?? [],
      }
    : undefined;
}

function parseUnique(ui_ext: any) {
  return ui_ext.is_unique_to_race || ui_ext.is_unique || ["UniqueBuildingUpgradeDataTemplate", "BuildingImprovedUpgradeDataTemplate"].includes(ui_ext.tooltip_data_template);
}

function parseInfluences(ui_ext: any) {
  if (ui_ext.ui_extra_infos)
    return ui_ext.ui_extra_infos?.reduce((inf, x) => {
      const str = getTranslation(
        x.description || x.description_formatter.formatter,
        x.description_formatter?.formatter_arguments?.map((x) => Object.values(x)[0] ?? x)
      );
      if (["influence_buff", "influence_decorator"].includes(x.icon)) inf.push(str);
      return inf;
    }, [] as string[]);
}

export function maybeOnKey(obj: any, key: string) {
  return obj?.[key] ?? obj;
}
