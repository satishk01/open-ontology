import { describe, it, expect } from "vitest";
import { ossieOntology } from "../apps/api/src/routes/ontology.js";

const types = [
  {
    name: "Customer",
    description: "A paying account",
    primaryKey: "customer_id",
    properties: ["customer_id", "email", "lifetime_value"],
    datasetId: "ds1",
  },
  {
    name: "Order",
    description: "",
    primaryKey: "order_id",
    properties: ["order_id", "customer_id", "total"],
    datasetId: "ds2",
  },
];
const relationships = [
  {
    name: "placed",
    fromType: "Customer",
    toType: "Order",
    fromColumn: "customer_id",
    toColumn: "customer_id",
  },
  // A link to a type outside the live ontology is dropped.
  {
    name: "stale",
    fromType: "Customer",
    toType: "Legacy",
    fromColumn: "customer_id",
    toColumn: "id",
  },
];
const columnTypes: Record<string, Record<string, string>> = {
  ds1: { customer_id: "VARCHAR", email: "VARCHAR", lifetime_value: "DOUBLE" },
  ds2: { order_id: "BIGINT", customer_id: "VARCHAR", total: "DECIMAL(10,2)" },
};
const columnType = (d: string, c: string) => columnTypes[d]?.[c];

describe("Ossie ontology export", () => {
  const doc = ossieOntology("Acme ontology", types, relationships, columnType);

  it("emits an EntityType concept per object type", () => {
    expect(doc.name).toBe("Acme ontology");
    expect(doc.ontology).toHaveLength(2);
    const customer = doc.ontology[0];
    expect(customer.concept).toBe("Customer");
    expect(customer.type).toBe("EntityType");
    expect(customer.description).toBe("A paying account");
    expect(customer.identify_by).toEqual(["customer_id"]);
  });

  it("maps columns to built-in value types with verbalized relationships", () => {
    const customer = doc.ontology[0];
    const byName = Object.fromEntries(
      customer.relationships.map((r: any) => [r.name, r]),
    ) as any;
    expect(byName.customer_id.multiplicity).toBe("OneToOne");
    expect(byName.customer_id.roles[0].concept).toBe("String");
    expect(byName.email.roles[0].concept).toBe("String");
    expect(byName.lifetime_value.roles[0].concept).toBe("Float");
    for (const r of customer.relationships) {
      expect((r as any).verbalizes.length).toBeGreaterThan(0);
      expect((r as any).verbalizes[0]).toContain("{Customer}");
    }
    const order = doc.ontology[1];
    const orderRels = Object.fromEntries(
      order.relationships.map((r: any) => [r.name, r]),
    ) as any;
    expect(orderRels.order_id.roles[0].concept).toBe("Integer");
    expect(orderRels.total.roles[0].concept).toBe("Decimal");
  });

  it("emits link types as entity relationships under their first-role concept", () => {
    const customer = doc.ontology[0];
    const placed = customer.relationships.find(
      (r: any) => r.name === "placed",
    ) as any;
    expect(placed.roles[0].concept).toBe("Order");
    expect(placed.verbalizes[0]).toBe("{Customer} placed {Order}");
    expect(placed.annotations.helix.fromColumn).toBe("customer_id");
    expect(
      customer.relationships.some((r: any) => r.name === "stale"),
    ).toBe(false);
  });

  it("keeps Helix bindings in annotations", () => {
    expect(doc.ontology[0].annotations.helix.datasetId).toBe("ds1");
  });
});
