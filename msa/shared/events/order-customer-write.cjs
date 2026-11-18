"use strict";
const { createHash } = require("node:crypto");
const { validateReadScope } = require("./read-scope.cjs");
const { validateRecipientReceipt } = require("./order-recipient-pins.cjs");
const ORDER_CREATION_LOCK = 20261112;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, expected) =>
  object(value) && Object.keys(value).sort().join(",") === expected;
const id = (value) =>
  Number.isInteger(value) && value > 0 && value <= 2147483647;
const phone = (value) => typeof value === "string" && /^[0-9]+$/.test(value);

function customerPreparationId(value) {
  if (!phone(value)) throw new Error("Invalid preparation phone");
  const hash = createHash("sha256")
    .update("dva.order-customer:" + value)
    .digest("hex");
  return (
    hash.slice(0, 8) +
    "-" +
    hash.slice(8, 12) +
    "-5" +
    hash.slice(13, 16) +
    "-8" +
    hash.slice(17, 20) +
    "-" +
    hash.slice(20, 32)
  );
}

function validateCreatedCustomer(value) {
  if (
    !keys(
      value,
      "address,customerSeq,monthlyBillingEnabled,name,phoneNumber,status",
    ) ||
    !id(value.customerSeq) ||
    typeof value.name !== "string" ||
    !value.name.isWellFormed() ||
    value.name.includes("\u0000") ||
    !phone(value.phoneNumber) ||
    value.status !== "ACTIVE" ||
    value.monthlyBillingEnabled !== false ||
    value.address !== null
  )
    throw new Error("Invalid created order customer");
}

function validateCustomerCreationReceipt(value) {
  if (!keys(value, "eventId,payload"))
    throw new Error("Invalid customer creation receipt");
  validateReadScope(value.eventId);
  const p = value.payload;
  if (
    !keys(p, "adminId,customer,requestId,writeEventId") ||
    !(p.adminId === null || id(p.adminId)) ||
    typeof p.requestId !== "string" ||
    p.requestId.length < 1 ||
    p.requestId.length > 128
  )
    throw new Error("Invalid customer creation payload");
  validateReadScope(p.writeEventId);
  validateCreatedCustomer(p.customer);
}

function validateCustomerPreparationOutcome(value) {
  if (keys(value, "status") && ["PENDING", "ABORTED"].includes(value.status))
    return;
  if (
    !keys(value, "customerCreationReceipt,recipientReceipt,status") ||
    value.status !== "COMMITTED"
  )
    throw new Error("Invalid customer preparation outcome");
  validateCustomerCreationReceipt(value.customerCreationReceipt);
  if (value.recipientReceipt === null) return;
  validateRecipientReceipt(value.recipientReceipt);
  const created = value.customerCreationReceipt.payload,
    pins = value.recipientReceipt.payload;
  if (
    pins.customerSeq !== created.customer.customerSeq ||
    pins.writeEventId !== created.writeEventId ||
    pins.adminId !== created.adminId ||
    pins.requestId !== created.requestId
  )
    throw new Error("Customer and recipient preparation mismatch");
}

module.exports = {
  ORDER_CREATION_LOCK,
  customerPreparationId,
  validateCreatedCustomer,
  validateCustomerCreationReceipt,
  validateCustomerPreparationOutcome,
};
