import type { Filter, ObjectId } from "mongodb";
import { services, type Service } from "./services.js";

export const publishedServiceFilter: Filter<Service> = {
  status: "approved",
  $or: [{ isActive: true }, { isActive: { $exists: false }, active: true }],
};

export const publicVendorLookup = {
  $lookup: {
    from: "user",
    let: { vendorId: { $convert: { input: "$vendorId", to: "objectId", onError: null, onNull: null } } },
    pipeline: [
      { $match: { $expr: { $eq: ["$_id", "$$vendorId"] }, role: "vendor", blocked: { $ne: true } } },
      { $project: { _id: 0, name: 1 } },
    ],
    as: "vendor",
  },
};

export function readPublishedService(id: ObjectId) {
  return services.aggregate<Pick<Service, "vendorId" | "title" | "category" | "description" | "location" | "priceMinor" | "imageUrl" | "imageUrls"> & {
    id: string;
    vendor: { name: string }[];
  }>([
    { $match: { ...publishedServiceFilter, _id: id } },
    publicVendorLookup,
    { $project: {
      _id: 0, id: { $toString: "$_id" }, title: 1, category: 1, description: 1, location: 1,
      priceMinor: 1, imageUrl: 1, imageUrls: 1, vendorId: 1, vendor: 1,
    } },
  ]).next();
}
