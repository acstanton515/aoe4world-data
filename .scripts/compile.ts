import path from "path";
import { FOLDERS } from "./lib/config";
import { CIVILIZATIONS } from "./lib/config/civs";
import { getAllUnits } from "./lib/files/readUnitData";
import { writeJson } from "./lib/files/writeUnitData";
import { unifyItems } from "./lib/utils/items";

const meta = {
  __note__: "This is file is autogenerated, do not edit it manually. For more info https://data.aoe4world.com/",
  __version__: "0.0.2",
};

/** Creates index files for units */
(async () => {
  const units = await getAllUnits();
  writeJson;
  const unified = unifyItems(units);

  writeJson(path.join(FOLDERS.UNITS.DATA, "all.json"), { ...meta, data: units });
  writeJson(path.join(FOLDERS.UNITS.DATA, "all-unified.json"), { ...meta, data: unified });
  unified.forEach((u) => writeJson(path.join(FOLDERS.UNITS.DATA, `unified/${u.id}.json`), Object.assign({}, meta, u), { log: false }));

  Object.values(CIVILIZATIONS).forEach((civ) => {
    const civUnits = units.filter((u) => u.civs.includes(civ.abbr));
    writeJson(path.join(FOLDERS.UNITS.DATA, `${civ.slug}.json`), { ...meta, civ: civ, data: civUnits });
    writeJson(path.join(FOLDERS.UNITS.DATA, `${civ.slug}-unified.json`), { ...meta, civ: civ, data: unifyItems(civUnits) });
  });
})();
