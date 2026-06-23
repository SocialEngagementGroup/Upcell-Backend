const mongoose = require("mongoose");

const oldUri = process.env.OLD_MONGODB_URL;
const newUri = process.env.NEW_MONGODB_URL;

if (!oldUri || !newUri) {
  console.error("OLD_MONGODB_URL and NEW_MONGODB_URL are required.");
  process.exit(1);
}

async function copyIndexes(sourceCollection, targetCollection) {
  const indexes = await sourceCollection.indexes();
  const customIndexes = indexes.filter((index) => index.name !== "_id_");

  for (const index of customIndexes) {
    const { key, name, ns, v, ...options } = index;
    await targetCollection.createIndex(key, options);
  }
}

async function migrateCollection(sourceDb, targetDb, collectionName) {
  const sourceCollection = sourceDb.collection(collectionName);
  const targetCollection = targetDb.collection(collectionName);
  const docs = await sourceCollection.find({}).toArray();

  await copyIndexes(sourceCollection, targetCollection);

  if (docs.length === 0) {
    return { collectionName, copied: 0 };
  }

  const result = await targetCollection.bulkWrite(
    docs.map((doc) => ({
      replaceOne: {
        filter: { _id: doc._id },
        replacement: doc,
        upsert: true,
      },
    })),
    { ordered: false }
  );

  return {
    collectionName,
    copied: docs.length,
    inserted: result.upsertedCount,
    modified: result.modifiedCount,
  };
}

async function main() {
  const source = await mongoose.createConnection(oldUri).asPromise();
  const target = await mongoose.createConnection(newUri).asPromise();

  try {
    const collections = await source.db.listCollections().toArray();

    for (const collection of collections) {
      const result = await migrateCollection(source.db, target.db, collection.name);
      console.log(
        `${result.collectionName}: copied=${result.copied}, inserted=${result.inserted || 0}, modified=${result.modified || 0}`
      );
    }
  } finally {
    await source.close();
    await target.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
