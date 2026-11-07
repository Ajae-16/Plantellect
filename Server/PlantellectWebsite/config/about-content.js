/**
 * The text of the About page, in one place. The mobile app reads it from GET /api/about (routes/about.js)
 * and shows it on the Home page, so a wording change here reaches the app without a new app release.
 * (public/about.html still carries its own copy of the same words.)
 *
 * Each section has a stable `id` (the app picks an icon by it), a `heading` and a `body`.
 */
module.exports = {
    title: 'About Plantellect',
    intro:
        'Welcome to Plantellect\u2014your digital community companion for exploring and viewing plants identified ' +
        'through their leaves and stems, empowering you to explore the flora within your community.',
    sections: [
        {
            id: 'what-we-do',
            heading: 'What we do',
            body:
                'Plantellect is a dedicated community platform where users can explore and view plants uploaded by ' +
                'individuals who hold authority within the system. By focusing on key vegetative traits like stems ' +
                'and leaves, our platform connects you with plant entries to help you discover the flora right around you.'
        },
        {
            id: 'our-mission',
            heading: 'Our mission',
            body:
                'We aim to make botany accessible, educational, and engaging for students, gardeners, and nature ' +
                'enthusiasts alike. By centering around a collaborative community and focusing on physical traits like ' +
                'stems and leaves, Plantellect empowers users to explore the flora within their community.'
        },
        {
            id: 'community',
            heading: 'Community and contributions',
            body:
                'Our library is powered by contributions from individuals who have been granted authority to upload ' +
                'within the system. Users can easily browse these uploaded profiles to discover species names, ' +
                'classifications, and detailed descriptions of local plant life.'
        }
    ]
};
