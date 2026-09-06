const { Schema, model, models } = require("mongoose");

// A singleton: one document holding the list of category names currently on
// sale. Every caller reads it the same way — AvailableCatagories.find() then
// act[0] — in category.controller.js and product.controller.js.
//
// `unique: true` used to sit on `categories` below. On an array field that
// builds a unique *multikey* index, which does not mean "one document" at all:
// it means no two documents may share even one category string. It never fired
// because there has only ever been one document, and if a second were ever
// added it would fail with an error that pointed at the wrong thing entirely.
//
// NOTE: removing it here does not drop the index Mongo already built. See
// PIPELINE.md for the one-line command to drop it.
const AvailableCatagoriesSchema = new Schema({
    categories: {
        type: [String],
        required: true,
      }
})

const AvailableCatagories = models?.AvailableCatagories || model("AvailableCatagories", AvailableCatagoriesSchema)

module.exports = AvailableCatagories
