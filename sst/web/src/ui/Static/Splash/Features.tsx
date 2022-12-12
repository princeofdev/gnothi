import React, {useState, useEffect} from "react"
import Grid from "@mui/material/Grid";

import {sx, FeatureCard, colors, spacing, Section} from './Utils'
import Typography from "@mui/material/Typography";

export default function Features() {
  return <Grid>
    <Section color="dark">
      <Typography variant="h2">Explore the features</Typography>
    </Section>
    <Section>
      Feature cards
    </Section>    
  </Grid>
}