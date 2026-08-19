// Small shared helpers (math / random utilities).
'use strict';

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const round1 = (v) => Math.round(v * 10) / 10;

module.exports = { clamp, rand, randInt, pick, round1 };
