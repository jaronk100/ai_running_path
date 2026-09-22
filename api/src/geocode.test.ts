import assert from "node:assert/strict";
import { test } from "node:test";
import { addressMatches, parseAddress } from "./geocode.js";

test("an address is split into number, direction and street", () => {
  const a = parseAddress("1011 S Bagdad Rd, Leander, TX 78641");
  assert.equal(a.houseNumber, "1011");
  assert.equal(a.direction, "south");
  assert.deepEqual(a.streetWords, ["bagdad"]);

  const b = parseAddress("11840 Crystal Falls Pkwy, Leander, TX 78641");
  assert.equal(b.houseNumber, "11840");
  assert.equal(b.direction, null);
  assert.deepEqual(b.streetWords, ["crystal", "falls"]);

  // A place name has no house number and no suffix to strip.
  const c = parseAddress("Mason Homestead, Leander, TX");
  assert.equal(c.houseNumber, null);
  assert.deepEqual(c.streetWords, ["mason", "homestead"]);
});

test("a dropped directional prefix is rejected", () => {
  // The real failure: the Census geocoder answered "1011 S Bagdad Rd" with
  // "1011 BAGDAD RD" -- a different road, 2 miles from the library. Every route
  // was then built around the wrong place, which looked like a maths bug.
  assert.equal(
    addressMatches("1011 S Bagdad Rd, Leander, TX 78641", "1011 BAGDAD RD, LEANDER, TX, 78641"),
    false,
  );
  assert.equal(
    addressMatches("1011 S Bagdad Rd, Leander, TX 78641", "1011 South Bagdad Road"),
    true,
  );
});

test("a different house number is rejected", () => {
  assert.equal(addressMatches("1101 S Bagdad Rd", "1011 S Bagdad Rd"), false);
  assert.equal(addressMatches("1101 S Bagdad Rd", "1101 South Bagdad Road"), true);
});

test("a different street is rejected", () => {
  assert.equal(addressMatches("2000 Crystal Falls Pkwy", "2000 Whitestone Blvd"), false);
});

test("suffix and case differences are accepted", () => {
  assert.equal(addressMatches("425 S Parkwest Dr, Cedar Park, TX", "425 SOUTH PARKWEST DRIVE"), true);
  assert.equal(addressMatches("2000 Crystal Falls Pkwy", "2000 Crystal Falls Parkway"), true);
});

test("a query without a direction accepts a result that has one", () => {
  // Asking loosely is fine; it is asking specifically and being ignored that is not.
  assert.equal(addressMatches("1011 Bagdad Rd", "1011 South Bagdad Road"), true);
});
