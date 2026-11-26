"use strict";

var dbm;
var type;
var seed;

/**
 * We receive the dbmigrate dependency from dbmigrate initially.
 * This enables us to not have to rely on NODE_PATH.
 */
exports.setup = function (options, seedLink) {
  dbm = options.dbmigrate;
  type = dbm.dataType;
  seed = seedLink;
};

// Tournament admin tools: a disqualified team loses every slot it hasn't played yet, and a slot whose teams an
// admin changed by hand keeps its generated sources in auto_sources (null = never edited) so it can be reset.
exports.up = async function (db) {
  await db.addColumn("tournament_team", "disqualified", { type: "boolean", notNull: true, defaultValue: false });
  await db.addColumn("tournament_match", "auto_sources", { type: "string", length: 255, notNull: false });
};

exports.down = async function (db) {
  await db.removeColumn("tournament_match", "auto_sources");
  await db.removeColumn("tournament_team", "disqualified");
};
exports._meta = {
  version: 43
};
