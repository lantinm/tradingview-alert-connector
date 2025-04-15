import express from 'express';
import * as Sentry from '@sentry/node';
import * as Tracing from '@sentry/tracing';
import { CaptureConsole as CaptureConsoleIntegration } from '@sentry/integrations';
import helmet from 'helmet';
import controller from './controllers/index'; // If you have controllers set up
import 'dotenv/config';

const app: express.Express = express();
const port = process.env.PORT || 3000;

// Sentry initialization (error tracking)
if (process.env.SENTRY_DNS) {
    Sentry.init({
        dsn: process.env.SENTRY_DNS,
        integrations: [
            new Sentry.Integrations.Http({ tracing: true }),
            new Tracing.Integrations.Express({ app }),
            new CaptureConsoleIntegration({ levels: ['error'] })
        ],
        tracesSampleRate: 1.0
    });

    app.use(Sentry.Handlers.requestHandler());
    app.use(Sentry.Handlers.tracingHandler());

    console.log('initialized Sentry.io');
}

// Security middleware
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// /test-alert route to handle TradingView alerts
app.post('/test-alert', (req, res) => {
    console.log('Received alert:', req.body); // Log the alert data
    res.status(200).send('Alert received'); // Respond with a confirmation
});

// Controller routes (if you have any)
app.use('/', controller);

// Error handling for Sentry
if (process.env.SENTRY_DNS) {
    app.use(Sentry.Handlers.errorHandler());
}

// Start the server
app.listen(port, () => {
    console.log(`TV-Connector web server listening on port ${port}`);
});
