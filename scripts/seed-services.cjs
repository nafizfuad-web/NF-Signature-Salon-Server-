/*
 * SalonBook — seed the service catalogue into MongoDB.
 *
 * The catalogue previously existed only as client-side fixtures. This script
 * upserts the 20 treatments by title, so it is safe to run repeatedly.
 * It never touches users or appointments.
 *
 * Usage: npm run seed:services
 */

const path = require('node:path')
const mongoose = require('mongoose')

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true })

const services = [
  {
    title: "Men's Haircut",
    description: 'A precision haircut tailored to your style.',
    price: '$35',
    duration: '45 min',
    category: 'hair',
    image: '/services/mens-haircut.jpg',
    featured: true,
    includes: ['Consultation', 'Precision cut', 'Wash and finish'],
    goodToKnow: ['Allow 45-60 minutes'],
  },
  {
    title: "Women's Haircut",
    description: 'A personalised cut for shape, movement and your routine.',
    price: '$55',
    duration: '60 min',
    category: 'hair',
    image: '/services/womens-haircut.jpg',
    featured: true,
    includes: ['Consultation', 'Custom cut', 'Wash and blow-dry'],
    goodToKnow: ['Bring reference photos if you have them'],
  },
  {
    title: 'Hair Styling',
    description: 'A polished blowout or occasion-ready finish.',
    price: '$45',
    duration: '45 min',
    category: 'hair',
    image: '/services/hair-styling.jpg',
    featured: true,
    includes: ['Style consultation', 'Blow-dry or finishing', 'Long-wear setting'],
    goodToKnow: ['Arrive with dry hair for an occasion style'],
  },
  {
    title: 'Hair Coloring',
    description: 'Custom salon colour for rich, dimensional results.',
    price: '$140',
    duration: '150 min',
    category: 'hair',
    image: '/services/hair-coloring.jpg',
    featured: true,
    includes: ['Colour consultation', 'Custom colour', 'Gloss and finish'],
    goodToKnow: ['A patch test is required 48 hours before first colour'],
  },
  {
    title: 'Hair Highlights',
    description: 'Dimensional lightening placed to flatter your cut and tone.',
    price: '$120',
    duration: '120 min',
    category: 'hair',
    image: '/services/hair-highlights.jpg',
    featured: false,
    includes: ['Tone and placement plan', 'Foil highlights', 'Toner and style'],
    goodToKnow: ['Results vary with your starting shade'],
  },
  {
    title: 'Hair Treatment',
    description: 'A restorative ritual to improve softness and shine.',
    price: '$65',
    duration: '60 min',
    category: 'hair',
    image: '/services/hair-treatment.jpg',
    featured: false,
    includes: ['Hair assessment', 'Deep-conditioning treatment', 'Heat treatment and finish'],
    goodToKnow: ['Ideal for dry or regularly styled hair'],
  },
  {
    title: 'Keratin Treatment',
    description: 'A smoothing treatment that reduces frizz and styling time.',
    price: '$180',
    duration: '150 min',
    category: 'hair',
    image: '/services/keratin-treatment.jpg',
    featured: true,
    includes: ['Hair assessment', 'Keratin application', 'Seal and style'],
    goodToKnow: ['Do not wash hair for 72 hours afterwards'],
  },
  {
    title: 'Hair Spa',
    description: 'A deeply relaxing scalp and hair hydration ritual.',
    price: '$75',
    duration: '60 min',
    category: 'hair',
    image: '/services/hair-spa.jpg',
    featured: false,
    includes: ['Scalp cleanse', 'Steam and masque', 'Scalp massage'],
    goodToKnow: ['Leave time to relax after the treatment'],
  },
  {
    title: 'Beard Trimming',
    description: 'A precise beard shape with clean, balanced lines.',
    price: '$25',
    duration: '30 min',
    category: 'hair',
    image: '/services/beard-trimming.jpg',
    featured: false,
    includes: ['Shape consultation', 'Trim and line-up', 'Beard conditioning'],
    goodToKnow: ['Tell us how you normally wear your beard'],
  },
  {
    title: 'Beard Styling',
    description: 'Custom beard shaping for a groomed, intentional finish.',
    price: '$30',
    duration: '35 min',
    category: 'hair',
    image: '/services/beard-styling.jpg',
    featured: false,
    includes: ['Length and shape design', 'Detail trimming', 'Beard oil finish'],
    goodToKnow: ['Allow extra time for major shape changes'],
  },
  {
    title: 'Shaving',
    description: 'A traditional hot-towel shave for a smooth finish.',
    price: '$28',
    duration: '30 min',
    category: 'hair',
    image: '/services/shaving.jpg',
    featured: false,
    includes: ['Hot towel preparation', 'Traditional shave', 'Cooling balm'],
    goodToKnow: ['Please mention sensitive or easily irritated skin'],
  },
  {
    title: 'Facial',
    description: 'A tailored facial that cleanses and restores radiance.',
    price: '$90',
    duration: '60 min',
    category: 'skin',
    image: '/services/facial.jpg',
    featured: true,
    includes: ['Skin analysis', 'Cleanse and exfoliation', 'Mask and hydration'],
    goodToKnow: ['Skip retinoids for 48 hours before your visit'],
  },
  {
    title: 'Skin Care',
    description: 'A custom skin ritual selected around your current concerns.',
    price: '$110',
    duration: '75 min',
    category: 'skin',
    image: '/services/skin-care.jpg',
    featured: true,
    includes: ['Skin consultation', 'Targeted treatment', 'Barrier care and SPF'],
    goodToKnow: ['Tell us about allergies and active skin products'],
  },
  {
    title: 'Manicure',
    description: 'Nail shaping and classic care for a polished finish.',
    price: '$40',
    duration: '45 min',
    category: 'nails',
    image: '/services/manicure.jpg',
    featured: true,
    includes: ['Nail shaping', 'Cuticle care', 'Classic polish'],
    goodToKnow: ['Bring inspiration for a specific shape'],
  },
  {
    title: 'Pedicure',
    description: 'A restorative foot ritual with shaping and polish.',
    price: '$55',
    duration: '50 min',
    category: 'nails',
    image: '/services/pedicure.jpg',
    featured: true,
    includes: ['Foot soak', 'Exfoliation', 'Shape and polish'],
    goodToKnow: ['Wear open-toe shoes afterwards'],
  },
  {
    title: 'Head Massage',
    description: 'A calming massage for scalp, neck and shoulder tension.',
    price: '$65',
    duration: '45 min',
    category: 'wellness',
    image: '/services/head-massage.jpg',
    featured: true,
    includes: ['Scalp massage', 'Neck and shoulder work', 'Warm oil finish'],
    goodToKnow: ['No need to undress'],
  },
  {
    title: 'Bridal Makeup',
    description: 'Long-wearing bridal makeup tailored to your features and look.',
    price: '$150',
    duration: '120 min',
    category: 'skin',
    image: '/services/bridal-makeup.jpg',
    featured: true,
    includes: ['Look consultation', 'Skin preparation', 'Bridal makeup and setting'],
    goodToKnow: ['Book a trial before the wedding date'],
  },
  {
    title: 'Party Makeup',
    description: 'A complete event look with professional finishing.',
    price: '$85',
    duration: '75 min',
    category: 'skin',
    image: '/services/party-makeup.jpg',
    featured: false,
    includes: ['Makeup consultation', 'Full-face makeup', 'Setting spray finish'],
    goodToKnow: ['Bring inspiration photos and jewellery references'],
  },
  {
    title: 'Eyebrow Threading',
    description: 'Precise shaping for a clean, natural brow line.',
    price: '$18',
    duration: '20 min',
    category: 'skin',
    image: '/services/eyebrow-threading.jpg',
    featured: false,
    includes: ['Shape consultation', 'Gentle threading', 'Soothing finish'],
    goodToKnow: ['Avoid exfoliating the brow area beforehand'],
  },
  {
    title: 'Waxing',
    description: 'Smooth, precise hair removal with a soothing finish.',
    price: '$50',
    duration: '45 min',
    category: 'skin',
    image: '/services/waxing.jpg',
    featured: false,
    includes: ['Area consultation', 'Professional waxing', 'Post-wax soothing care'],
    goodToKnow: ['Avoid sun exposure immediately afterwards'],
  },
]

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not configured in the server .env file.')
  }

  await mongoose.connect(process.env.MONGODB_URI)
  const collection = mongoose.connection.db.collection('services')
  let created = 0
  let updated = 0

  try {
    for (const service of services) {
      const now = new Date()
      const result = await collection.updateOne(
        { title: service.title },
        {
          $set: { ...service, active: true, updatedAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      )
      if (result.upsertedCount === 1) created += 1
      else if (result.modifiedCount === 1) updated += 1
    }

    const active = await collection.countDocuments({ active: true })
    console.log(JSON.stringify({ created, updated, active }))
  } finally {
    await mongoose.disconnect()
  }
}

main().catch((error) => {
  console.error('Service seed failed:', error instanceof Error ? error.name : 'UnknownError')
  process.exit(1)
})
