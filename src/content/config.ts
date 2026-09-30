import { defineCollection, z } from 'astro:content';

const restaurants = defineCollection({
  type: 'data',
  schema: z.object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    name: z.string().min(1),
    category: z.enum(['on-campus', 'off-campus']),
    kind: z.string().default('餐厅'),
    aliases: z.array(z.string()).default([]),
    relatedRestaurantIds: z.array(z.string()).default([]),
    location: z.string().min(1),
    coordinates: z.tuple([z.number(), z.number()]).nullable().default(null),
    price: z.string().default('待补充。'),
    openingHours: z.string().nullable().default(null),
    foods: z.array(z.object({ name: z.string(), location: z.string().nullable().default(null), description: z.string().nullable().default(null), price: z.string().nullable().default(null) })).default([]),
    reviews: z.array(z.object({ text: z.string(), author: z.string().nullable().default(null), source: z.string().nullable().default(null) })).default([]),
    body: z.string().default(''),
    images: z.array(z.object({ url: z.string().url(), alt: z.string(), source: z.string().nullable().default(null), permission: z.enum(['approved', 'external', 'pending']).default('external') })).default([]),
    sources: z.array(z.object({ repository: z.string(), path: z.string(), revision: z.string(), license: z.string().nullable().default(null), note: z.string().nullable().default(null) })).default([]),
    visitedAt: z.string().nullable().default(null),
    verifiedAt: z.string().nullable().default(null),
    updatedAt: z.string().nullable().default(null),
  }),
});

export const collections = { restaurants };
