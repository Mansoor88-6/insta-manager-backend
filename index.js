require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");


const app = express();

// Add security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Configure CORS for production
app.use(cors({
  origin: process.env.FRONTEND_URL || '*', // Replace with your frontend URL in production
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Add request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

const PORT = parseInt(process.env.PORT || "3000", 10);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);


app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

app.post("/api/instagram/setup", async (req, res) => {
  try {
    const { shortLivedToken, userId, facebookPageId } = req.body;

    if (!shortLivedToken || !userId || !facebookPageId) {
      return res.status(400).json({
        error: "Missing required parameters: shortLivedToken, userId, or facebookPageId",
      });
    }

    const longLivedTokenResponse = await axios.get(
      "https://graph.facebook.com/v18.0/oauth/access_token",
      {
        params: {
          grant_type: "fb_exchange_token",
          client_id: process.env.FACEBOOK_APP_ID,
          client_secret: process.env.FACEBOOK_APP_SECRET,
          fb_exchange_token: shortLivedToken,
        },
      }
    );

    const longLivedToken = longLivedTokenResponse.data.access_token;

    const accountResponse = await axios.get(
      `https://graph.facebook.com/v18.0/${facebookPageId}`,
      {
        params: {
          fields: "instagram_business_account",
          access_token: longLivedToken,
        },
      }
    );


    if (!accountResponse.data.instagram_business_account) {
      throw new Error(
        "No Instagram Business Account found for this Facebook Page"
      );
    }

    const instagramAccountId =
      accountResponse.data.instagram_business_account.id;


    try {
      const { data, error } = await supabase
        .from("instagram_accounts")
        .upsert({
          user_id: userId,
          instagram_account_id: instagramAccountId,
          facebook_page_id: facebookPageId,
          access_token: longLivedToken,
          connected_at: new Date().toISOString(),
        })
        .select();


      if (error) {
        console.error("Supabase error:", error);
        throw error;
      }

      res.json({
        success: true,
        instagram_account_id: instagramAccountId,
        data: data[0],
      });
    } catch (supabaseError) {
      res.status(500).json({
        error: "Failed to store Instagram credentials",
        details: supabaseError.message,
      });
    }
  } catch (error) {
    console.error("Instagram Setup Error:", error.response?.data || error);
    
    if (error.response?.data?.error) {
      return res.status(400).json({
        error: "Instagram API Error",
        details: error.response.data.error.message,
        code: error.response.data.error.code
      });
    }

    if (error.code === 'PGRST') {
      return res.status(400).json({
        error: "Database Error",
        details: error.message,
        code: error.code
      });
    }

    res.status(500).json({
      error: "Failed to setup Instagram integration",
      details: error.message
    });
  }
});


app.get("/api/instagram/posts/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = 18;

    const { data: accountData, error: accountError } = await supabase
      .from("instagram_accounts")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (accountError) throw accountError;
    if (!accountData) {
      return res.status(404).json({ error: "Instagram account not found" });
    }

    const profileResponse = await axios.get(
      `https://graph.facebook.com/v18.0/${accountData.instagram_account_id}`,
      {
        params: {
          fields: "username,profile_picture_url",
          access_token: accountData.access_token,
        },
      }
    );


    const totalCountResponse = await axios.get(
      `https://graph.facebook.com/v18.0/${accountData.instagram_account_id}/media`,
      {
        params: {
          limit: 0,
          access_token: accountData.access_token,
        },
      }
    );

    const totalPosts = totalCountResponse.data.data.length;
    const totalPages = Math.ceil(totalPosts / limit);

    let after = undefined;
    if (page > 1) {
      // Get the cursor for the previous page
      const cursorResponse = await axios.get(
        `https://graph.facebook.com/v18.0/${accountData.instagram_account_id}/media`,
        {
          params: {
            limit: (page - 1) * limit,
            access_token: accountData.access_token,
            fields: "id", 
          },
        }
      );

      if (cursorResponse.data.paging && cursorResponse.data.paging.cursors) {
        after = cursorResponse.data.paging.cursors.after;
      }
    }


    const postsResponse = await axios.get(
      `https://graph.facebook.com/v18.0/${accountData.instagram_account_id}/media`,
      {
        params: {
          fields:
            "id,caption,media_type,media_url,permalink,thumbnail_url,timestamp",
          access_token: accountData.access_token,
          limit: limit,
          ...(after && { after }),
        },
      }
    );


    res.json({
      success: true,
      profile: {
        username: profileResponse.data.username,
        profile_picture_url: profileResponse.data.profile_picture_url,
      },
      posts: postsResponse.data.data || [],
      pagination: {
        currentPage: page,
        totalPages,
        totalPosts,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
        limit,
      },
    });
  } catch (error) {
    console.error("Instagram Posts Error:", error.response?.data || error);

    if (error.response?.data?.error) {
      return res.status(400).json({
        error: "Instagram API Error",
        details: error.response.data.error.message,
        code: error.response.data.error.code
      });
    }

    if (error.message === "Instagram account not found") {
      return res.status(404).json({
        error: "Not Found",
        details: "Instagram account not found for this user"
      });
    }

    res.status(500).json({
      error: "Failed to fetch Instagram posts",
      details: error.message
    });
  }
});


app.post("/api/instagram/upload", async (req, res) => {
  try {
    const { userId, imageUrl, caption } = req.body;

    if (!userId || !imageUrl) {
      return res.status(400).json({
        error: "Missing required parameters: userId or imageUrl",
      });
    }


    const { data: accountData, error: accountError } = await supabase
      .from("instagram_accounts")
      .select("*")
      .eq("user_id", userId)
      .single();

    if (accountError) throw accountError;
    if (!accountData) {
      return res.status(404).json({ error: "Instagram account not found" });
    }

    const createContainerResponse = await axios.post(
      `https://graph.facebook.com/v18.0/${accountData.instagram_account_id}/media`,
      null,
      {
        params: {
          image_url: imageUrl,
          caption: caption || "",
          access_token: accountData.access_token,
        },
      }
    );

    if (!createContainerResponse.data.id) {
      throw new Error("Failed to create media container");
    }

    const containerId = createContainerResponse.data.id;

    const publishResponse = await axios.post(
      `https://graph.facebook.com/v18.0/${accountData.instagram_account_id}/media_publish`,
      null,
      {
        params: {
          creation_id: containerId,
          access_token: accountData.access_token,
        },
      }
    );

    res.json({
      success: true,
      post_id: publishResponse.data.id,
      message: "Image successfully posted to Instagram",
    });
  } catch (error) {
    console.error("Instagram Upload Error:", error.response?.data || error);

    if (error.message.includes("Image validation failed")) {
      return res.status(400).json({
        error: "Invalid Image",
        details: error.message
      });
    }

    if (error.response?.data?.error) {
      return res.status(400).json({
        error: "Instagram API Error",
        details: error.response.data.error.message,
        code: error.response.data.error.code
      });
    }

    if (error.message === "Instagram account not found") {
      return res.status(404).json({
        error: "Not Found",
        details: "Instagram account not found for this user"
      });
    }

    res.status(500).json({
      error: "Failed to upload image to Instagram",
      details: error.message
    });
  }
});

// Add error logging middleware at the bottom before app.listen
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    details: process.env.NODE_ENV === 'production' ? 'An unexpected error occurred' : err.message
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
