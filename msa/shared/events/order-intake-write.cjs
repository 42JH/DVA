"use strict";
const { createHash } = require("node:crypto");
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, names) =>
  object(value) && Object.keys(value).sort().join(",") === names;
const id = (value) =>
  Number.isInteger(value) && value > 0 && value <= 2147483647;
const nullableId = (value) => value === null || id(value);
const instant = (value) =>
  typeof value === "string" && Number.isFinite(Date.parse(value));
const uuid = (value) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function finalizationId(id) {
  const hash = createHash("sha256")
    .update("dva.order-intake-finalized:" + id)
    .digest("hex");
  return (
    hash.slice(0, 8) +
    "-" +
    hash.slice(8, 12) +
    "-5" +
    hash.slice(13, 16) +
    "-a" +
    hash.slice(17, 20) +
    "-" +
    hash.slice(20, 32)
  );
}
function validateCompletion(value) {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "expectedIntakeVersion",
          "paymentMethodType",
          "pickupRequestedAt",
        ].includes(key),
    ) ||
    !id(value.expectedIntakeVersion) ||
    (value.paymentMethodType !== undefined &&
      !["billing", "credit", "groupBilling"].includes(
        value.paymentMethodType,
      )) ||
    !(
      value.pickupRequestedAt === undefined ||
      value.pickupRequestedAt === null ||
      instant(value.pickupRequestedAt)
    )
  )
    throw new Error("Invalid intake completion");
}
function validateFinalization(value) {
  if (
    !keys(
      value,
      "callSessionSeq,eventId,expectedIntakeVersion,finalizedAt,orderSeq,parcelMappings,requestId",
    ) ||
    !uuid(value.eventId) ||
    !id(value.callSessionSeq) ||
    !id(value.expectedIntakeVersion) ||
    !nullableId(value.orderSeq) ||
    !instant(value.finalizedAt) ||
    typeof value.requestId !== "string" ||
    value.requestId.length < 1 ||
    value.requestId.length > 128 ||
    !Array.isArray(value.parcelMappings) ||
    (value.orderSeq === null) !== (value.parcelMappings.length === 0)
  )
    throw new Error("Invalid intake finalization");
  for (const mapping of value.parcelMappings)
    if (
      !keys(mapping, "draftSeq,orderParcelSeq") ||
      !id(mapping.draftSeq) ||
      !id(mapping.orderParcelSeq)
    )
      throw new Error("Invalid intake mapping");
  for (const field of ["draftSeq", "orderParcelSeq"])
    if (
      new Set(value.parcelMappings.map((mapping) => mapping[field])).size !==
      value.parcelMappings.length
    )
      throw new Error("Duplicate intake mapping");
}
function validatePolicy(value) {
  if (
    !keys(
      value,
      "departmentName,departmentSeq,group,monthly,organizationName,organizationSeq",
    ) ||
    typeof value.monthly !== "boolean" ||
    typeof value.group !== "boolean" ||
    !nullableId(value.organizationSeq) ||
    !nullableId(value.departmentSeq) ||
    ![value.organizationName, value.departmentName].every(
      (name) => name === null || typeof name === "string",
    ) ||
    (value.organizationSeq === null &&
      (value.departmentSeq !== null ||
        value.organizationName !== null ||
        value.departmentName !== null ||
        value.group)) ||
    (value.organizationSeq !== null &&
      typeof value.organizationName !== "string") ||
    (value.departmentSeq === null && value.departmentName !== null)
  )
    throw new Error("Invalid payment policy");
}
module.exports = {
  finalizationId,
  validateCompletion,
  validateFinalization,
  validatePolicy,
};
