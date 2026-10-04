import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { foodSchema, reviewSchema, venueSchema } from './lib/catalog/index';

const restaurants = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/restaurants' }),
  schema: venueSchema,
});

const foods = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/foods' }),
  schema: foodSchema,
});

const reviews = defineCollection({
  loader: glob({ pattern: '**/*.json', base: './src/content/reviews' }),
  schema: reviewSchema,
});

export const collections = { restaurants, foods, reviews };
