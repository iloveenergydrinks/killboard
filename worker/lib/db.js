"use strict";

const { Client } = require("pg");
const { databaseUrl } = require("./config");

const EXPECTED_ROLE = "ship_restore_reader";

async function connect() {
  const client = new Client({
    connectionString: databaseUrl(),
    options: "-c default_transaction_read_only=on",
  });
  try {
    await client.connect();
    const result = await client.query(
      "SELECT current_user, current_setting('transaction_read_only') AS read_only"
    );
    const session = result.rows[0];
    if (session.current_user !== EXPECTED_ROLE)
      throw new Error(
        `Ship restore requires database role '${EXPECTED_ROLE}', not '${session.current_user}'.`
      );
    if (session.read_only !== "on")
      throw new Error("The ship-restore database session is not read-only.");
    return client;
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }
}

module.exports = { connect };
