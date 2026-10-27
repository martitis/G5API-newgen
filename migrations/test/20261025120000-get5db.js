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

// Accounts can be registered without a Steam account: user.steam_id becomes optional (still unique when set;
// MySQL allows any number of NULLs in a unique column).
exports.up = async function (db) {
  await db.changeColumn("user", "steam_id", { type: "string", length: 17, notNull: false });
};

exports.down = async function (db) {
  await db.changeColumn("user", "steam_id", { type: "string", length: 17, notNull: true });
};
exports._meta = {
  version: 42
};
