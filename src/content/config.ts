import { defineCollection } from 'astro:content';
import { foodSchema, reviewSchema, venueSchema } from '../lib/catalog/index';

const restaurants = defineCollection({
  type: 'data',
  schema: venueSchema,
});

const foods = defineCollection({
  type: 'data',
  schema: foodSchema,
});

const reviews = defineCollection({
  type: 'data',
  schema: reviewSchema,
});

export const collections = { restaurants, foods, reviews };
